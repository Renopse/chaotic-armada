import { CARDS } from './cards.js';
import { Game, newGameState, COLOR_NAMES } from './engine.js';
import { botAnswer } from './bot.js';
import { Host, Guest } from './net.js';
import morphdom from './vendor/morphdom.js';
import { FEEDBACK, feedbackReady } from './config.js';

const C = (id) => CARDS[id];
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BOT_NAMES = ['Capitaine Crochu', 'Barbe-Grise', 'La Mouette', 'Jambe-de-Bois'];
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } } };

const ui = {
  screen: 'home', role: null, name: store.get('ca-name', ''), n: 4,
  seats: [], view: null, sel: null, zoom: null, multi: [], logOpen: false, rulesOpen: false,
  error: null, code: null, mySeat: 0, status: '',
};
let game = null, host = null, guest = null;
const seatTimers = {};

// ─────────────────────────── démarrage ───────────────────────────
const params = new URLSearchParams(location.search);
if (params.get('partie')) { ui.screen = 'join'; ui.code = params.get('partie').toUpperCase(); }
render();

// ─────────────────────────── actions communes ───────────────────────────
function send(msg) {
  if (ui.role === 'host' || ui.role === 'solo') handleMsg(0, msg);
  else if (guest) guest.send(msg);
}
function handleMsg(seat, msg) {
  if (!game) return;
  if (msg.t === 'choose') game.setChoice(seat, msg.ch);
  else if (msg.t === 'unchoose') game.unsetChoice(seat);
  else if (msg.t === 'answer') game.answer(seat, msg.id, msg.value);
  else if (msg.t === 'cont') game.continueReady(seat);
}

// ─────────────────────────── hôte ───────────────────────────
function startSolo() {
  ui.role = 'solo';
  const players = [{ name: ui.name || 'Vous', isBot: false }];
  for (let i = 1; i < ui.n; i++) players.push({ name: BOT_NAMES[i - 1], isBot: true });
  launch(players);
}
function startHosting() {
  ui.role = 'host'; ui.screen = 'lobby'; ui.status = 'Ouverture du salon…';
  ui.seats = [{ kind: 'host', name: ui.name || 'Hôte' }];
  render();
  host = new Host({
    onOpen: (code) => { ui.code = code; ui.status = ''; render(); },
    onError: (err) => { ui.status = 'Erreur réseau : ' + (err.type || err.message) + '. Vous pouvez toujours jouer contre des bots.'; render(); },
    onGuestMessage: guestMessage,
    onGuestClose: guestClose,
  });
}
function lobbyBroadcast() {
  for (const s of ui.seats) if (s.connId) host.send(s.connId, { t: 'lobby', seats: ui.seats.map(x => ({ kind: x.kind, name: x.name })), n: ui.n });
}
// Battement de cœur : un invité silencieux depuis 10 s est considéré comme déconnecté
setInterval(() => {
  if (ui.role !== 'host') return;
  ui.seats.forEach((s) => { if (s.kind === 'human' && s.connId && Date.now() - (s.lastSeen || 0) > 10000) guestClose(s.connId); });
}, 2000);
function guestMessage(connId, msg) {
  const known = ui.seats.find(s => s.connId === connId); if (known) known.lastSeen = Date.now();
  if (msg.t === 'ping') return;
  if (msg.t === 'hello') {
    const name = String(msg.name || 'Pirate').slice(0, 20);
    let seat = ui.seats.findIndex(s => s.token && s.token === msg.token);
    if (game) {
      if (seat < 0) { host.send(connId, { t: 'refuse', reason: 'La partie a déjà commencé.' }); return; }
      const s = ui.seats[seat]; s.connId = connId; s.connected = true; s.lastSeen = Date.now();
      clearTimeout(seatTimers[seat]);
      const p = game.P(seat);
      if (p.isBot) { p.isBot = false; game.log(`${p.name} est de retour !`); }
      host.send(connId, { t: 'welcome', seat });
      game.update();
      return;
    }
    if (seat < 0) {
      if (ui.seats.length >= ui.n) { host.send(connId, { t: 'refuse', reason: 'La partie est complète.' }); return; }
      ui.seats.push({ kind: 'human', name, token: msg.token, connId, connected: true, lastSeen: Date.now() });
      seat = ui.seats.length - 1;
    } else { Object.assign(ui.seats[seat], { connId, connected: true, lastSeen: Date.now() }); }
    host.send(connId, { t: 'welcome', seat });
    lobbyBroadcast(); render();
    return;
  }
  const seat = ui.seats.findIndex(s => s.connId === connId);
  if (seat > 0) handleMsg(seat, msg);
}
function guestClose(connId) {
  const seat = ui.seats.findIndex(s => s.connId === connId);
  if (seat <= 0) return;
  const s = ui.seats[seat]; host.close(connId); s.connId = null; s.connected = false;
  if (!game) { ui.seats.splice(seat, 1); lobbyBroadcast(); render(); return; }
  game.log(`${s.name} s'est déconnecté. Un bot prendra sa place dans 20 secondes s'il ne revient pas.`);
  game.update();
  seatTimers[seat] = setTimeout(() => {
    if (!ui.seats[seat].connected) { game.log(`Un bot joue désormais pour ${s.name}.`); game.botTakeover(seat); game.update(); }
  }, 20000);
}
function hostStartGame() {
  const players = ui.seats.map(s => ({ name: s.name, isBot: false }));
  let b = 0;
  while (players.length < ui.n) { players.push({ name: BOT_NAMES[b++], isBot: true }); ui.seats.push({ kind: 'bot', name: players[players.length - 1].name }); }
  launch(players);
}
function launch(players) {
  const st = newGameState(players);
  game = new Game(st, { botAnswer, delay: 600, onUpdate: scheduleBroadcast });
  ui.screen = 'game'; ui.mySeat = 0;
  game.run().catch(e => { console.error(e); ui.error = 'Erreur du moteur : ' + e.message; render(); });
  scheduleBroadcast();
}
let bTimer = null;
function scheduleBroadcast() {
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = null;
    ui.view = game.viewFor(0); render();
    if (host) ui.seats.forEach((s, i) => { if (i > 0 && s.connId) host.send(s.connId, { t: 'view', view: game.viewFor(i) }); });
  }, 40);
}

// ─────────────────────────── invité ───────────────────────────
function joinGame() {
  ui.role = 'guest'; ui.screen = 'lobby'; ui.status = 'Connexion à la partie…'; render();
  let token = store.get('ca-token-' + ui.code, '');
  if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('ca-token-' + ui.code, token); }
  guest = new Guest(ui.code, {
    onOpen: () => { ui.status = ''; guest.send({ t: 'hello', name: ui.name || 'Pirate', token }); setInterval(() => guest.send({ t: 'ping' }), 3000); render(); },
    onMessage: (m) => {
      if (m.t === 'welcome') { ui.mySeat = m.seat; ui.status = ''; }
      else if (m.t === 'lobby') { ui.seats = m.seats; ui.n = m.n; ui.screen = 'lobby'; }
      else if (m.t === 'view') { ui.view = m.view; ui.screen = 'game'; }
      else if (m.t === 'refuse') { ui.status = m.reason; guest.closed = true; }
      render();
    },
    onClose: () => { ui.status = "Connexion perdue avec l'hôte. Rechargez la page pour vous reconnecter."; render(); },
    onError: (err) => {
      ui.status = err.type === 'peer-unavailable' ? "Partie introuvable : l'hôte a peut-être fermé son onglet." : 'Erreur réseau : ' + (err.type || err.message);
      render();
    },
  });
}

// ─────────────────────────── rendu ───────────────────────────
function render() {
  let html = '';
  if (ui.screen === 'home') html = homeHTML();
  else if (ui.screen === 'join') html = joinHTML();
  else if (ui.screen === 'lobby') html = lobbyHTML();
  else if (ui.screen === 'game' && ui.view) {
    const pid = ui.view.prompt && ui.view.prompt.id;
    if (pid !== ui.promptId) { ui.promptId = pid; ui.multi = []; }
    html = gameHTML(ui.view);
  }
  else html = `<div class="center-screen"><p>${esc(ui.status || 'Chargement…')}</p></div>`;
  if (ui.zoom) html += zoomHTML(ui.zoom);
  if (ui.rulesOpen) html += rulesHTML();
  html += `<button class="fbfab" data-act="fb" title="Envoyer un commentaire">💬 Commentaire</button>`;
  if (ui.fb) html += feedbackHTML();
  if (ui.error) html += `<div class="toast">${esc(ui.error)}</div>`;
  morphdom($app, `<div id="app">${html}</div>`, {
    onBeforeElUpdated: (from, to) => {
      if (from === document.activeElement && (from.tagName === 'INPUT' || from.tagName === 'TEXTAREA')) return false;
      return !from.isEqualNode(to);
    },
  });
}

function homeHTML() {
  return `<div class="home">
    <img class="logo" src="assets/logo.webp" alt="Chaotic Armada">
    <div class="panel">
      <label>Votre nom de pirate<input id="name" maxlength="20" value="${esc(ui.name)}" placeholder="ex. Anne la Rouge"></label>
      <div class="row"><span>Joueurs :</span>
        ${[3, 4].map(n => `<button class="chip ${ui.n === n ? 'on' : ''}" data-act="n" data-n="${n}">${n}</button>`).join('')}
      </div>
      <button class="big" data-act="solo">⚔️ Jouer contre des bots</button>
      <button class="big alt" data-act="host">🔗 Créer une partie en ligne</button>
      <p class="hint">En ligne : vous recevez un lien à partager. Vos amis n'ont besoin d'aucun compte. Les places libres sont prises par des bots.</p>
      <button class="link" data-act="rules">📜 Règles du jeu</button>
    </div>
  </div>`;
}
function joinHTML() {
  return `<div class="home">
    <img class="logo" src="assets/logo.webp" alt="Chaotic Armada">
    <div class="panel">
      <h2>Rejoindre la partie ${esc(ui.code)}</h2>
      <label>Votre nom de pirate<input id="name" maxlength="20" value="${esc(ui.name)}" placeholder="ex. Jack le Borgne"></label>
      <button class="big" data-act="join">🏴‍☠️ Rejoindre</button>
      <button class="link" data-act="rules">📜 Règles du jeu</button>
    </div>
  </div>`;
}
function lobbyHTML() {
  const ps = params.get('peerserver');
  const link = ui.code ? `${location.origin}${location.pathname}?partie=${ui.code}${ps ? '&peerserver=' + ps : ''}` : '';
  const seats = [];
  for (let i = 0; i < ui.n; i++) {
    const s = ui.seats[i];
    seats.push(`<li class="seat c-${['red', 'yellow', 'green', 'blue'][i]}"><span class="dot"></span>${s ? esc(s.name) + (s.kind === 'host' ? ' (hôte)' : '') + (i === ui.mySeat && ui.role === 'guest' ? ' (vous)' : '') : '<em>Place libre : un bot jouera</em>'}</li>`);
  }
  return `<div class="home">
    <img class="logo small" src="assets/logo.webp" alt="Chaotic Armada">
    <div class="panel">
      <h2>Salon de la partie</h2>
      ${ui.status ? `<p class="status">${esc(ui.status)}</p>` : ''}
      ${ui.role === 'host' && link ? `
        <p>Envoyez ce lien à vos amis :</p>
        <div class="copy"><input readonly value="${esc(link)}" id="link"><button data-act="copy">Copier</button></div>
        <div class="row"><span>Joueurs :</span>${[3, 4].map(n => `<button class="chip ${ui.n === n ? 'on' : ''}" data-act="n" data-n="${n}" ${ui.seats.length > n ? 'disabled' : ''}>${n}</button>`).join('')}</div>` : ''}
      <ul class="seats">${seats.join('')}</ul>
      ${ui.role === 'host' ? `<button class="big" data-act="start" ${ui.code ? '' : 'disabled'}>🚀 Lancer la partie</button>
        <p class="hint">⚠️ Gardez cet onglet ouvert pendant toute la partie : c'est lui qui fait tourner le jeu.</p>` :
        `<p class="hint">En attente du lancement par l'hôte…</p>`}
    </div>
  </div>`;
}

// ── Plateau ──
const SLOT_LEFT = [6.05, 23.63, 41.3, 59.07, 76.75];
const ICON = { F: '⚔️', G: '🪙', P: '⭐' };
const RES = { F: 'Force', G: 'or', P: 'PG' };
const iconTxt = (ic) => ic ? `+${ic[1]} ${RES[ic[0]]}` : '';
function cardImg(id, cls = '') { return `<img class="card ${cls}" src="${C(id).img}" alt="${esc(C(id).name)}" data-zoom="${id}" loading="lazy" draggable="false">`; }
const back = (cls = '') => `<div class="card back ${cls}"><span>☠</span></div>`;

function statsHTML(p, v) {
  const onV = v.vigie === p.idx;
  const ready = v.phase === 'choose' ? (p.ready ? '<span class="tag ok">prêt</span>' : '<span class="tag wait">réfléchit…</span>') : '';
  const interl = v.phase === 'interlude' ? (p.ready ? '<span class="tag ok">prêt</span>' : '<span class="tag wait">…</span>') : '';
  return `<div class="stats c-${p.color}">
    <span class="pname"><span class="dot"></span>${esc(p.name)}${p.isBot ? ' 🤖' : ''}${p.idx === v.me ? ' (vous)' : ''}</span>
    <span title="Pièces d'or">🪙 ${p.gold}</span><span title="Force">⚔️ ${p.force}</span><span title="Points de Gloire">⭐ ${p.pg}</span>
    <span title="Cartes en main">🂠 ${Array.isArray(p.hand) ? p.hand.length : p.hand}</span>
    ${onV ? '<span class="tag vig" title="Sur la vigie">🔭 vigie</span>' : ''}${p.eliminated ? '<span class="tag bad">éliminé</span>' : ''}${ready}${interl}
  </div>`;
}
function shipHTML(p, v, mine) {
  const slots = p.slots.map((s, k) => {
    let inner = '';
    if (s) {
      if (s.hidden) inner = s.card ? `<div class="hid">${cardImg(s.card, 'dim')}<span class="hlabel">face cachée</span></div>` : back();
      else inner = cardImg(s.card);
    }
    const hl = ui.hlSlots && mine && ui.hlSlots.includes(k) ? ' hl' : '';
    return `<div class="slot${hl}" style="left:${SLOT_LEFT[k]}%">${inner}<span class="snum">${k + 1}</span></div>`;
  }).join('');
  const top = p.discard && p.discard.length ? p.discard[p.discard.length - 1] : null;
  const legends = p.legends.filter(Boolean).map(l => cardImg(l, 'leg')).join('');
  return `<div class="ship ${mine ? 'mine' : ''}">
    <img class="ship-bg" src="assets/ship.webp" alt="" draggable="false">
    ${slots}
    <div class="discard" title="Défausse (${p.discardCount})">${top ? cardImg(top, 'dsc') : ''}<span class="dcount">${p.discardCount}</span></div>
    <div class="legends">${legends}</div>
  </div>`;
}
function centralHTML(v) {
  const LL = [7.04, 28.64, 51.17, 73.05];
  const legendsAll = Object.values(CARDS).filter(c => c.type === 'legend' && c.round === v.round).map(c => c.id);
  const vig = v.vigie != null ? `<img class="token" src="assets/token-${v.players[v.vigie].color}.webp" alt="vigie" title="${esc(v.players[v.vigie].name)} est sur la vigie">` : '';
  return `<div class="central">
    <img class="central-bg" src="assets/central.webp" alt="" draggable="false">
    <div class="pioche"><b>${v.pioche}</b> <small>carte${v.pioche > 1 ? 's' : ''} en pioche</small></div>
    <div class="vigie">${vig}${v.vigieBroken ? '<span class="broken">CASSÉE</span>' : ''}</div>
    <div class="fleau">${v.fleau ? cardImg(v.fleau, 'fl') + `<div class="fstats">🛡️ Déf ${v.fleauDef} · ❤️ PV ${Math.max(0, v.fleauHp)}</div>` : ''}</div>
    ${legendsAll.map((l, j) => `<div class="lslot" style="left:${LL[j]}%">${v.legendsAvail.includes(l) ? cardImg(l) : ''}</div>`).join('')}
  </div>`;
}
function phaseText(v) {
  const me = v.players[v.me];
  if (v.prompt && v.prompt.player !== v.me) return `⏳ ${esc(v.players[v.prompt.player].name)} fait un choix : ${esc(v.prompt.title)}`;
  switch (v.phase) {
    case 'choose': return me.ready ? `⏳ En attente des autres joueurs (${v.players.filter(p => p.ready).length}/${v.n} prêts)` : '👉 Choisissez une carte de votre main';
    case 'resolve': return '⚙️ Résolution du tour…';
    case 'combat': return `⚔️ Combat contre le Fléau`;
    case 'interlude': return '🌊 Fin de la manche';
    case 'over': return '🏁 Partie terminée';
    default: return 'Mise en place…';
  }
}
const MODE_LABEL = { action: 'Action', pirate: 'Recrute', hidden: 'Face cachée', gold: 'Défausse pour de l\'or', legend: 'Pirate légendaire' };
function revealHTML(v) {
  if (!v.reveal || v.phase === 'choose') return '';
  return `<div class="reveal"><h3>Cartes révélées</h3><div class="rv">${v.reveal.map(r => {
    const p = v.players[r.player];
    const img = r.card != null ? cardImg(r.card, 'sm') : back('sm');
    const extra = r.mode === 'pirate' || r.mode === 'hidden' ? ` (pos. ${r.slot + 1})` : r.mode === 'legend' ? ` : ${esc(C(r.legend).name)}` : '';
    return `<div class="rcard c-${p.color}">${img}<span><span class="dot"></span>${esc(p.name)}</span><small>${MODE_LABEL[r.mode]}${extra}</small></div>`;
  }).join('')}</div></div>`;
}
function combatHTML(v) {
  if (!v.combat) return '';
  const rows = v.combat.order.map(i => {
    const p = v.players[i]; const r = v.combat.results.find(x => x.i === i);
    let txt = v.combat.current === i ? '⚔️ attaque…' : '';
    if (r) txt = r.skipped ? 'n\'attaque pas (Fléau vaincu)' : r.fail ? `${r.start} Force : Défense non franchie` : `${r.start} Force → ${r.dmg} dégâts, +${r.dmg} PG`;
    return `<li class="c-${p.color}"><span class="dot"></span><b>${esc(p.name)}</b> <span>${txt}</span></li>`;
  }).join('');
  const res = v.combat.done ? (v.fleauHp <= 0 ? '<p class="win">Le Fléau est vaincu !</p>' : `<p class="lose">Le Fléau n'est pas vaincu : ${esc(C(v.fleau).text)}</p>`) : '';
  return `<div class="combat"><h3>Combat : ${esc(C(v.fleau).name)}</h3><ol>${rows}</ol>${res}</div>`;
}
function handHTML(v) {
  const me = v.players[v.me];
  if (!Array.isArray(me.hand)) return '';
  const choosing = v.phase === 'choose' && !me.ready;
  const cards = me.hand.map(id => `<div class="hcard ${ui.sel === id ? 'sel' : ''} ${choosing ? 'pick' : ''}" data-act="${choosing ? 'sel' : 'zoom'}" data-id="${id}">${cardImg(id)}</div>`).join('');
  let panel = '';
  if (v.phase === 'choose' && me.ready && me.chosen) {
    const ch = me.chosen;
    panel = `<div class="mpanel done">Vous jouez ${cardImg(ch.card, 'xs')} <b>${MODE_LABEL[ch.mode]}</b>${ch.slot != null ? ` en position ${ch.slot + 1}` : ''}${ch.legend ? ` : ${esc(C(ch.legend).name)}` : ''}
      <button data-act="unchoose">Changer</button></div>`;
  } else if (choosing && ui.sel != null && me.hand.includes(ui.sel)) panel = modePanel(v, ui.sel);
  return `<div class="hand-wrap"><div class="hand">${cards}</div>${panel}</div>`;
}
function modePanel(v, id) {
  const c = C(id); const modes = v.modes[id] || [];
  const me = v.players[v.me];
  const btn = (m, label, sub = '') => `<button class="mbtn" ${m.ok || m.mode === 'hidden' ? '' : 'disabled'} data-act="mode" data-mode="${m.mode}" data-slot="${m.slot ?? ''}" data-legend="${m.legend ?? ''}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`;
  let h = `<div class="mpanel"><div class="mhead">${cardImg(id, 'md')}<div><h4>${esc(c.type === 'action' ? 'Action' : c.name)}</h4><p>${esc(c.text)}</p>
    ${c.place ? `<p class="plc">Placement : ${c.place.map((x, k) => `<span>${k + 1}: ${x ? ICON[x[0]] + x[1] : '–'}</span>`).join('')}</p>` : ''}</div></div>`;
  if (c.type === 'action') {
    const m = modes.find(x => x.mode === 'action');
    h += `<div class="mgroup">${btn(m, `▶️ Jouer l'action`, `coût ${m.cost} or`)}</div>`;
  } else {
    const ups = modes.filter(x => x.mode === 'pirate');
    if (ups.length) h += `<div class="mgroup"><span class="glabel">Recruter face visible (coût payé maintenant) :</span>${ups.map(m => btn(m, `Position ${m.slot + 1}`, `${m.cost} or${c.place && c.place[m.slot] ? ' · ' + ICON[c.place[m.slot][0]] + iconTxt(c.place[m.slot]) : ''}${me.slots[m.slot] ? ' · remplace' : ''}`)).join('')}</div>`;
    const hid = modes.filter(x => x.mode === 'hidden');
    h += `<div class="mgroup"><span class="glabel">Poser face cachée (gratuit ; à payer ou défausser avant le combat) :</span>${hid.map(m => btn(m, `Position ${m.slot + 1}`, me.slots[m.slot] ? 'remplace' : 'vide')).join('')}</div>`;
  }
  const g = modes.find(x => x.mode === 'gold');
  h += `<div class="mgroup">${btn(g, `🪙 Défausser pour ${g.gain} or`)}`;
  for (const m of modes.filter(x => x.mode === 'legend')) h += btn(m, `👑 Défausser pour ${esc(C(m.legend).name)}`, `${m.cost} or`);
  h += `</div><button class="link" data-act="desel">Annuler</button></div>`;
  return h;
}
function promptHTML(v) {
  const pr = v.prompt;
  if (!pr || pr.player !== v.me || pr.waiting) return '';
  const multi = !!pr.max;
  const opts = pr.options.map(o => {
    const on = multi && ui.multi.includes(o.value);
    const img = o.card != null ? cardImg(o.card, 'xs') : '';
    return `<button class="popt ${on ? 'on' : ''}" data-act="${multi ? 'ptoggle' : 'panswer'}" data-v='${esc(JSON.stringify(o.value))}'>${img}<span>${esc(o.label)}</span></button>`;
  }).join('');
  const footer = multi ? `<div class="pfoot"><span>${ui.multi.length} sélectionné(s)${pr.min ? ` · minimum ${pr.min}` : ''} · maximum ${pr.max}</span><button class="big" data-act="pmulti" ${ui.multi.length < (pr.min || 0) ? 'disabled' : ''}>Valider</button></div>` : '';
  const ctx = pr.card != null ? `<div class="pctx">${cardImg(pr.card, 'md')}</div>` : '';
  return `<div class="modal"><div class="mbox"><h3>${esc(pr.title)}</h3>${ctx}<div class="popts">${opts}</div>${footer}</div></div>`;
}
function resultHTML(v) {
  if (v.phase !== 'over' || !v.result) return '';
  const rule = { least: 'Hafgufa : le joueur avec le moins de gloire gagne !', richest: 'Léviathan : le joueur le plus riche gagne !', megalodon: 'Megalodon : le joueur avec le plus de PG a été éliminé !' }[v.result.rule] || '';
  const rows = v.result.ranking.map((i, k) => { const p = v.players[i]; return `<li class="c-${p.color} ${v.result.winners.includes(i) ? 'w' : ''}"><span class="dot"></span><b>${esc(p.name)}</b> <span>⭐ ${p.pg} · 🪙 ${p.gold}${p.eliminated ? ' · éliminé' : ''}</span>${v.result.winners.includes(i) ? ' 🏆' : ''}</li>`; }).join('');
  return `<div class="modal"><div class="mbox"><h2>🏆 Victoire de ${v.result.winners.map(i => esc(v.players[i].name)).join(' et ')} !</h2>${rule ? `<p>${esc(rule)}</p>` : ''}<ol class="ranking">${rows}</ol>
    <button class="big" data-act="home">Nouvelle partie</button></div></div>`;
}
function gameHTML(v) {
  const me = v.players[v.me];
  const others = [];
  for (let k = 1; k < v.n; k++) others.push(v.players[(v.me + k) % v.n]);
  const interlude = v.phase === 'interlude' ? `<div class="interlude">${me.ready ? '⏳ En attente des autres joueurs…' : `<button class="big" data-act="cont">Continuer vers la manche ${v.round + 1} ➜</button>`}</div>` : '';
  return `<div class="game">
    <header class="topbar"><img src="assets/logo.webp" class="mini-logo" alt=""><span class="rtag">Manche ${v.round} · Tour ${Math.max(1, v.turn)}/6</span><div class="phase">${phaseText(v)}</div>
      <button class="tbtn" data-act="rules">📜 Règles</button><button class="tbtn" data-act="log">📒 Journal</button></header>
    ${ui.status ? `<div class="banner">${esc(ui.status)}</div>` : ''}
    <div class="layout ${ui.logOpen ? 'withlog' : ''}">
      <main>
        <section class="opponents">${others.map(p => `<div class="opp">${statsHTML(p, v)}${shipHTML(p, v, false)}</div>`).join('')}</section>
        <section class="board-row">
          <div class="board-col">${centralHTML(v)}${revealHTML(v)}${combatHTML(v)}${interlude}</div>
          <div class="me">${statsHTML(me, v)}${shipHTML(me, v, true)}</div>
        </section>
        <section class="hand-row">${handHTML(v)}</section>
      </main>
      ${ui.logOpen ? `<aside class="log"><h3>Journal</h3><div class="log-list">${v.log.slice().reverse().map(l => `<p class="${l.startsWith('══') || l.startsWith('──') ? 'sep' : ''}">${esc(l)}</p>`).join('')}</div></aside>` : ''}
    </div>
    ${promptHTML(v)}${resultHTML(v)}
  </div>`;
}
function fbContext() {
  const parts = [];
  const v = ui.view;
  if (ui.fbCard) { const c = C(ui.fbCard); parts.push(`Carte n°${c.id} ${c.type === 'action' ? 'Action' : c.name} (manche ${c.round}) : ${c.text}`); }
  if (ui.screen === 'game' && v) parts.push(`Partie : manche ${v.round}, tour ${v.turn}, phase ${v.phase}, ${v.n} joueurs`);
  else parts.push(`Écran : ${ui.screen}`);
  parts.push(`Mode : ${ui.role || 'accueil'}`);
  parts.push(`Écran ${window.innerWidth}x${window.innerHeight}`);
  return parts.join(' | ');
}
function feedbackHTML() {
  if (ui.fbSent) return `<div class="modal"><div class="mbox"><button class="close" data-act="fbclose">✕</button><h3>Merci !</h3><p>Votre commentaire a bien été envoyé.</p><button class="big" data-act="fbclose">Fermer</button></div></div>`;
  return `<div class="modal"><div class="mbox fb"><button class="close" data-act="fbclose">✕</button>
    <h3>💬 Votre commentaire</h3>
    <p class="hint">Une règle mal appliquée, un bug, une idée, une carte à équilibrer… Tout est utile !</p>
    ${ui.fbCard ? `<div class="fbcard">${cardImg(ui.fbCard, 'xs')}<span>À propos de : <b>${esc(C(ui.fbCard).type === 'action' ? 'Action' : C(ui.fbCard).name)}</b></span></div>` : ''}
    <textarea id="fbtext" rows="6" placeholder="Écrivez ici…">${esc(ui.fbText || '')}</textarea>
    <label>Votre nom (facultatif)<input id="fbname" maxlength="40" value="${esc(ui.fbName ?? ui.name)}"></label>
    <p class="hint">Contexte joint automatiquement : ${esc(fbContext())}</p>
    ${ui.fbErr ? `<p class="status">${esc(ui.fbErr)}</p>` : ''}
    <button class="big" data-act="fbsend" ${(ui.fbText || '').trim() ? '' : 'disabled'}>Envoyer</button>
  </div></div>`;
}
async function sendFeedback() {
  const text = (ui.fbText || '').trim(); if (!text) return;
  if (!feedbackReady()) { ui.fbErr = "Le formulaire de commentaires n'est pas encore configuré."; render(); return; }
  const body = new URLSearchParams();
  body.append(FEEDBACK.fields.message, text);
  if (FEEDBACK.fields.context) body.append(FEEDBACK.fields.context, fbContext());
  if (FEEDBACK.fields.name) body.append(FEEDBACK.fields.name, ui.fbName ?? ui.name ?? '');
  try {
    await fetch(`https://docs.google.com/forms/d/e/${FEEDBACK.formId}/formResponse`, { method: 'POST', mode: 'no-cors', body });
    ui.fbSent = true; ui.fbText = ''; ui.fbErr = null;
  } catch (e) { ui.fbErr = "Échec de l'envoi. Vérifiez votre connexion et réessayez."; }
  render();
}
function zoomHTML(id) {
  const c = C(id);
  const extra = c.type === 'fleau' ? `<p>Défense ${c.def} × joueurs · PV ${c.hp} × joueurs</p>` : c.type === 'legend' ? `<p>Coût ${c.cost} or</p>` : `<p>Coût ${c.cost} or${c.type !== 'action' ? ` · Force ${c.force}` : ''}${c.inst ? ' · effet immédiat ⚡' : c.text ? ' · effet permanent' : ''}</p>`;
  return `<div class="modal" data-act="unzoom"><div class="zoom"><img src="${c.img}" alt=""><div class="ztext"><h3>${esc(c.type === 'action' ? 'Action' : c.name)}</h3><p>${esc(c.text)}</p>${extra}<button class="mbtn" data-act="fbcard" data-id="${id}">💬 Commenter cette carte</button></div></div></div>`;
}
function rulesHTML() {
  return `<div class="modal" data-act="unrules"><div class="mbox rules" data-stop="1"><button class="close" data-act="unrules">✕</button>
  <h2>Règles en bref</h2>
  <p>Trois manches de <b>6 tours</b>, chacune suivie d'un <b>combat</b> contre un Fléau. Le joueur avec le plus de <b>Points de Gloire (⭐ PG)</b> à la fin gagne (égalité : le plus d'or).</p>
  <h3>Début de manche</h3><p>5 cartes par joueur, une pioche de 5 cartes par joueur, 1 Fléau et 4 Pirates légendaires révélés. Chaque joueur gagne 7 or.</p>
  <h3>Un tour</h3>
  <ol><li>On complète sa main à 5 cartes (dès le tour 2).</li>
  <li>Chacun choisit secrètement une carte, puis tout est révélé en même temps. Une carte peut :
    <ul><li><b>Action</b> : payer son coût et appliquer l'effet ;</li>
    <li><b>Recruter un pirate</b> face visible sur une des 5 positions du navire (payer son coût ; remplace le pirate présent) ;</li>
    <li><b>Placer un pirate face cachée</b> (gratuit) ; avant le combat, on le révèle en payant son coût ou on le défausse pour de l'or ;</li>
    <li><b>Défausser pour de l'or</b> : 4 / 6 / 8 or selon la manche ;</li>
    <li><b>Défausser pour recruter un Pirate légendaire</b> (en payant son coût ; 2 places maximum).</li></ul></li>
  <li>Résolution : effets de placement, puis effets immédiats ⚡ des pirates, puis Actions. Ordre de priorité : plus de Force, puis plus d'or, puis plus de PG.</li>
  <li>On passe ses 4 cartes restantes au voisin de droite. Le joueur sur la <b>vigie</b> gagne 1 / 1 / 2 PG.</li></ol>
  <p><b>Effet de placement</b> : si la position choisie correspond à une icône en bas de la carte, on gagne le bonus (⚔️ Force, 🪙 or, ⭐ PG). Un pirate est « bien placé » s'il est sur une de ses positions.</p>
  <p><b>Vigie</b> : si plusieurs joueurs grimpent au même tour, personne ne monte, chacun gagne 2 / 2 / 4 PG et l'occupant redescend.</p>
  <p><b>Esquive</b> : posée face cachée, elle peut être révélée pour annuler un effet adverse et gagner 2 Force (le jeu vous le propose).</p>
  <h3>Combat</h3><p>Les cartes restantes en main sont retirées. Chacun révèle ou défausse ses pirates face cachée, puis ajoute la Force de son équipage. Dans l'ordre (plus de Force, plus d'or, moins de PG), chaque joueur paie la <b>Défense</b> du Fléau puis inflige autant de dégâts qu'il peut : 1 PG par point de vie retiré. Le joueur qui ne franchit pas la Défense perd toute sa Force. Celui qui achève le Fléau garde sa Force restante, ainsi que ceux qui n'ont pas attaqué. Si le Fléau survit, son effet s'applique.</p>
  <p>Les pirates, l'or, la Force restante et les défausses sont conservés d'une manche à l'autre.</p>
  <p class="hint">Astuce : cliquez sur n'importe quelle carte pour l'agrandir.</p>
  </div></div>`;
}

// ─────────────────────────── événements ───────────────────────────
$app.addEventListener('input', (e) => {
  if (e.target.id === 'name') { ui.name = e.target.value; store.set('ca-name', ui.name); }
  if (e.target.id === 'fbtext') { const was = !!(ui.fbText || '').trim(); ui.fbText = e.target.value; if (was !== !!ui.fbText.trim()) render(); }
  if (e.target.id === 'fbname') ui.fbName = e.target.value;
});
$app.addEventListener('click', (e) => {
  const z = e.target.closest('[data-zoom]');
  const a = e.target.closest('[data-act]');
  if (a && a.dataset.act === 'sel') { onAct(a, e); return; }
  if (z && !e.target.closest('.popt') && !e.target.closest('.mbtn') && !(a && a.dataset.act === 'unzoom')) { ui.zoom = +z.dataset.zoom; render(); return; }
  if (!a) return;
  if (a.dataset.act === 'unrules' && e.target.closest('[data-stop]') && !e.target.closest('.close')) return;
  onAct(a, e);
});
function onAct(a) {
  const act = a.dataset.act; const v = ui.view;
  switch (act) {
    case 'n': ui.n = +a.dataset.n; if (host) lobbyBroadcast(); break;
    case 'solo': startSolo(); break;
    case 'host': startHosting(); break;
    case 'join': joinGame(); break;
    case 'start': hostStartGame(); break;
    case 'copy': { const i = document.getElementById('link'); i.select(); navigator.clipboard?.writeText(i.value).catch(() => {}); a.textContent = 'Copié !'; return; }
    case 'rules': ui.rulesOpen = true; break;
    case 'fb': ui.fb = true; ui.fbCard = null; ui.fbSent = false; ui.fbErr = null; break;
    case 'fbcard': ui.fb = true; ui.fbCard = +a.dataset.id; ui.zoom = null; ui.fbSent = false; ui.fbErr = null; break;
    case 'fbclose': ui.fb = false; ui.fbSent = false; break;
    case 'fbsend': sendFeedback(); return;
    case 'unrules': ui.rulesOpen = false; break;
    case 'log': ui.logOpen = !ui.logOpen; break;
    case 'zoom': ui.zoom = +a.dataset.id; break;
    case 'unzoom': ui.zoom = null; break;
    case 'sel': ui.sel = ui.sel === +a.dataset.id ? null : +a.dataset.id; render(); if (ui.sel != null) document.querySelector('.mpanel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return;
    case 'desel': ui.sel = null; break;
    case 'mode': {
      const ch = { card: ui.sel, mode: a.dataset.mode };
      if (a.dataset.slot !== '') ch.slot = +a.dataset.slot;
      if (a.dataset.legend !== '') ch.legend = +a.dataset.legend;
      send({ t: 'choose', ch }); ui.sel = null; break;
    }
    case 'unchoose': send({ t: 'unchoose' }); break;
    case 'panswer': send({ t: 'answer', id: v.prompt.id, value: JSON.parse(a.dataset.v) }); ui.multi = []; break;
    case 'ptoggle': { const val = JSON.parse(a.dataset.v); const i = ui.multi.indexOf(val); if (i >= 0) ui.multi.splice(i, 1); else if (ui.multi.length < v.prompt.max) ui.multi.push(val); break; }
    case 'pmulti': send({ t: 'answer', id: v.prompt.id, value: ui.multi }); ui.multi = []; break;
    case 'cont': send({ t: 'cont' }); break;
    case 'home': location.href = location.pathname; return;
  }
  render();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ui.zoom = null; ui.rulesOpen = false; ui.fb = false; render(); } });
window.addEventListener('beforeunload', (e) => { if (game && ui.role === 'host' && ui.view && ui.view.phase !== 'over') { e.preventDefault(); e.returnValue = ''; } });
