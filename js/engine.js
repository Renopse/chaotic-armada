// Moteur de règles de Chaotic Armada. Aucun accès au DOM : tourne dans le navigateur de l'hôte (et dans Node pour les tests).
import { CARDS, isPirateType, ROUND_CARDS, LEGENDS, FLEAUX } from './cards.js';

export const COLORS = ['red', 'yellow', 'green', 'blue'];
export const COLOR_NAMES = { red: 'Rouge', yellow: 'Jaune', green: 'Vert', blue: 'Bleu' };
const GOLD_DISCARD = [4, 6, 8];
const VIGIE_PG = [1, 1, 2];
const VIGIE_CLASH_PG = [2, 2, 4];

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const C = (id) => CARDS[id];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function newGameState(players) {
  // players : [{name, isBot}]
  return {
    phase: 'setup', round: 0, turn: 0, n: players.length,
    players: players.map((p, i) => ({
      idx: i, name: p.name, isBot: !!p.isBot, color: COLORS[i],
      gold: 0, force: 0, pg: 0, hand: [], discard: [], removed: [],
      slots: [null, null, null, null, null], legends: [null, null],
      chosen: null, ready: false, eliminated: false, gainedForce: false,
    })),
    pioche: [], legendsAvail: [], fleau: null, fleauHp: 0, fleauDef: 0,
    vigie: null, vigieBroken: false, victoryRule: null,
    log: [], events: [], evSeq: 0, prompt: null, reveal: null, combat: null, result: null, seq: 0,
  };
}

export class Game {
  constructor(state, opts = {}) {
    this.s = state;
    this.sim = !!opts.sim;
    this.botAnswer = opts.botAnswer;          // (game, playerIdx, prompt) => answer
    this.onUpdate = opts.onUpdate || (() => {});
    this.onChooseStart = opts.onChooseStart;
    this.delay = opts.delay ?? 0;
    this.waiters = {};                        // réponses humaines en attente
    this.chooseWaiter = null;
    this.climbers = new Set();
    this.corsaire = new Set();
  }

  // ─────────────────────────── utilitaires ───────────────────────────
  P(i) { return this.s.players[i]; }
  get N() { return this.s.n; }
  others(i) { return this.s.players.filter(q => q.idx !== i && !q.eliminated).map(q => q.idx); }
  right(i) { return (i + 1) % this.N; }
  left(i) { return (i - 1 + this.N) % this.N; }
  neighbors(i) { return [...new Set([this.left(i), this.right(i)])].filter(q => q !== i); }
  nm(i) { return this.P(i).name; }
  log(msg) {
    if (this.sim) return;
    this.s.log.push(msg);
    if (this.s.log.length > 300) this.s.log.shift();
  }
  update() { if (!this.sim) { this.s.seq++; this.onUpdate(); } }
  async pause(ms) {
    if (this.dead) throw new Error('abandoned');
    if (!this.sim && this.delay) { this.update(); await sleep(ms ?? this.delay); }
    if (this.dead) throw new Error('abandoned');
  }
  // Événements pour les animations de l'interface
  ev(o) {
    if (this.sim) return;
    const s = this.s; s.evSeq = (s.evSeq || 0) + 1;
    (s.events ||= []).push({ id: s.evSeq, ...o });
    if (s.events.length > 60) s.events.shift();
  }
  pay(i, n, why) { if (n <= 0) return; this.P(i).gold -= n; this.ev({ type: 'res', p: i, res: 'G', n: -n, why }); }

  // Pirates face visible (positions + légendaires)
  faceUp(i) {
    const p = this.P(i); const out = [];
    p.slots.forEach((s, k) => { if (s && !s.hidden) out.push(s.card); });
    p.legends.forEach(l => { if (l) out.push(l); });
    return out;
  }
  count(i, id) { return this.faceUp(i).filter(c => c === id).length; }
  has(i, id) { return this.count(i, id) > 0; }
  pirateCount(i) { const p = this.P(i); return p.slots.filter(Boolean).length + p.legends.filter(Boolean).length; }
  occupied(i) { return this.P(i).slots.map((s, k) => s ? k : -1).filter(k => k >= 0); }
  faceUpSlots(i) { return this.P(i).slots.map((s, k) => s && !s.hidden ? k : -1).filter(k => k >= 0); }
  icon(i, slot) { const s = this.P(i).slots[slot]; if (!s || s.hidden) return null; const c = C(s.card); return c.place ? c.place[slot] : null; }
  wellPlaced(i) { return this.faceUpSlots(i).filter(k => this.icon(i, k)); }
  crewForce(i) { let f = 0; for (const id of this.faceUp(i)) f += C(id).force || 0; return f; }

  priority() {
    const ps = this.s.players.filter(p => !p.eliminated).map(p => ({ i: p.idx, r: Math.random(), p }));
    ps.sort((a, b) => (b.p.force - a.p.force) || (b.p.gold - a.p.gold) || (b.p.pg - a.p.pg) || (a.r - b.r));
    return ps.map(x => x.i);
  }

  // ─────────────────────────── demandes aux joueurs ───────────────────────────
  // prompt : {kind, title, options:[{value,label,card?}], min?, max?, harmful?}
  async ask(i, prompt) {
    const p = this.P(i);
    if (!prompt.options || prompt.options.length === 0) return prompt.max ? [] : null;
    if (prompt.options.length === 1 && !prompt.max && !prompt.always) return prompt.options[0].value;
    if (this.sim || p.isBot) {
      if (!this.sim && this.delay) await this.pause(350);
      return this.botAnswer(this, i, prompt);
    }
    this.s.prompt = { player: i, ...prompt, id: Math.random().toString(36).slice(2) };
    this.update();
    const ans = await new Promise(res => { this.waiters[i] = { res, id: this.s.prompt.id, prompt: this.s.prompt }; });
    this.s.prompt = null;
    this.update();
    return ans;
  }
  answer(i, id, value) {
    const w = this.waiters[i];
    if (!w || w.id !== id) return false;
    const pr = w.prompt;
    if (pr.max) {
      if (!Array.isArray(value)) return false;
      const ok = value.every(v => pr.options.some(o => o.value === v)) && value.length >= (pr.min || 0) && value.length <= pr.max;
      if (!ok) return false;
    } else if (!pr.options.some(o => o.value === value)) return false;
    delete this.waiters[i];
    w.res(value);
    return true;
  }
  // Un joueur humain est remplacé par un bot (déconnexion) : on répond à sa place.
  botTakeover(i) {
    const p = this.P(i); p.isBot = true;
    const w = this.waiters[i];
    if (w) { delete this.waiters[i]; w.res(this.botAnswer(this, i, w.prompt)); }
    if (this.s.phase === 'choose' && !p.ready) this.botChoose(i);
  }

  async botChoose(i) {
    const p = this.P(i);
    if (p.ready || this.s.phase !== 'choose') return;
    let ch = await this.botAnswer(this, i, { kind: 'choose' });
    if (!p.ready && this.s.phase === 'choose' && !this.setChoice(i, ch)) this.setChoice(i, { card: p.hand[0], mode: 'gold' });
  }
  choosePlayer(i, cands, title, harmful) {
    return this.ask(i, { kind: harmful ? 'target-harm' : 'target-help', title, harmful,
      options: cands.map(q => ({ value: q, label: this.nm(q) })) });
  }
  slotOptions(i, filter = () => true) {
    const p = this.P(i);
    return [0, 1, 2, 3, 4].filter(filter).map(k => {
      const s = p.slots[k];
      return { value: k, label: `Position ${k + 1}` + (s ? (s.hidden ? ' (remplace un pirate caché)' : ` (remplace ${C(s.card).name})`) : ' (vide)'), slot: k };
    });
  }
  pirateOptions(i, slots) {
    const p = this.P(i);
    return slots.map(k => ({ value: k, label: `${C(p.slots[k].card).name}${p.slots[k].hidden ? ' – face cachée' : ''} (pos. ${k + 1})`, card: p.slots[k].card, owner: i, slot: k }));
  }

  // ─────────────────────────── ressources ───────────────────────────
  gainForce(i, n, why) {
    if (n <= 0) return;
    const bonus = this.count(i, 43) + this.count(i, 81);
    const t = n + bonus;
    this.P(i).force += t; this.P(i).gainedForce = true;
    this.ev({ type: 'res', p: i, res: 'F', n: t, why });
    this.log(`${this.nm(i)} gagne ${t} Force${why ? ' (' + why + ')' : ''}.`);
  }
  gainPG(i, n, why) {
    if (n <= 0) return;
    const t = n + this.count(i, 81);
    this.P(i).pg += t;
    this.ev({ type: 'res', p: i, res: 'P', n: t, why });
    this.log(`${this.nm(i)} gagne ${t} PG${why ? ' (' + why + ')' : ''}.`);
  }
  gainGold(i, n, why) {
    if (n <= 0) return;
    this.P(i).gold += n;
    this.ev({ type: 'res', p: i, res: 'G', n, why });
    this.log(`${this.nm(i)} gagne ${n} or${why ? ' (' + why + ')' : ''}.`);
    if (n >= 3) for (const q of this.neighbors(i)) {
      const k = this.count(q, 22); if (k) { this.P(q).gold += k; this.ev({ type: 'res', p: q, res: 'G', n: k, why: 'Parasite' }); this.log(`${this.nm(q)} gagne ${k} or (Parasite).`); }
    }
  }
  loseForce(i, n, why) {
    const p = this.P(i); const t = Math.min(n, p.force);
    if (t <= 0) return 0;
    p.force -= t; this.corsaire.add(i); this.ev({ type: 'res', p: i, res: 'F', n: -t, why });
    this.log(`${this.nm(i)} perd ${t} Force${why ? ' (' + why + ')' : ''}.`);
    return t;
  }
  loseGold(i, n, why) {
    const p = this.P(i); const t = Math.min(n, p.gold); p.gold -= t; if (t > 0) this.ev({ type: 'res', p: i, res: 'G', n: -t, why });
    if (t > 0) this.log(`${this.nm(i)} perd ${t} or${why ? ' (' + why + ')' : ''}.`);
    return t;
  }
  losePG(i, n, why) {
    const p = this.P(i); const t = Math.min(n, p.pg); p.pg -= t; if (t > 0) this.ev({ type: 'res', p: i, res: 'P', n: -t, why });
    if (t > 0) this.log(`${this.nm(i)} perd ${t} PG${why ? ' (' + why + ')' : ''}.`);
    return t;
  }
  stealForce(i, q, n) { const t = this.loseForce(q, n, `volé par ${this.nm(i)}`); this.gainForce(i, t); }
  stealGold(i, q, n) { const t = this.loseGold(q, n, `volé par ${this.nm(i)}`); this.gainGold(i, t); }
  stealPG(i, q, n) { const t = this.losePG(q, n, `volé par ${this.nm(i)}`); this.gainPG(i, t); }

  // Double corsaire : après chaque effet, si un adversaire a perdu de la Force
  flush() {
    if (this.corsaire.size === 0) return;
    const losers = [...this.corsaire]; this.corsaire.clear();
    for (const p of this.s.players) {
      const k = this.count(p.idx, 102);
      if (k && losers.some(l => l !== p.idx)) this.gainForce(p.idx, 2 * k, 'Double corsaire');
    }
    this.corsaire.clear();
  }

  // Un effet d'une carte de `src` vise `q`. Retourne false si l'effet est annulé (Sentinelle ou Esquive).
  async affect(src, q, harmful = true) {
    if (src === q || src === null) return true;
    if (!harmful) return true;
    if (this.s.vigie === q && this.has(q, 26)) { this.log(`${this.nm(q)} est immunisé (Sentinelle du mât sur la vigie).`); return false; }
    const p = this.P(q);
    const k = p.slots.findIndex(s => s && s.hidden && C(s.card).type === 'esquive');
    if (k >= 0) {
      const yes = await this.ask(q, { kind: 'dodge', title: `${this.nm(src)} vous vise. Révéler votre Esquive pour annuler l'effet et gagner 2 Force ?`, always: true,
        options: [{ value: true, label: 'Esquiver !' }, { value: false, label: 'Subir l\'effet' }] });
      if (yes) {
        const card = p.slots[k].card; p.slots[k] = null; p.removed.push(card);
        this.log(`${this.nm(q)} révèle une Esquive et annule l'effet !`);
        this.gainForce(q, 2, 'Esquive');
        return false;
      }
    }
    return true;
  }

  // ─────────────────────────── coûts ───────────────────────────
  pirateCost(i, id, slot, opts = {}) {
    const c = C(id); let cost = c.cost;
    const p = this.P(i);
    cost -= 2 * this.count(i, 53);
    cost += 2 * this.count(i, 24);
    cost -= 5 * this.count(i, 90);
    cost -= 3 * this.count(i, 128);
    if (slot != null && !opts.reveal) {
      const occ = p.slots[slot];
      if (occ) {
        if (!occ.hidden && occ.card === 8) cost -= 5;
        if (!occ.hidden && occ.card === 20) cost -= 3;
        if (id === 52) cost -= 5;
      }
    }
    return Math.max(0, cost);
  }
  actionCost(i, id) {
    let cost = C(id).cost;
    cost -= 2 * this.count(i, 54);
    cost += 2 * this.count(i, 25);
    cost -= 5 * this.count(i, 90);
    cost -= 3 * this.count(i, 128);
    return Math.max(0, cost);
  }
  legendCost(i, id) {
    let cost = C(id).cost;
    cost -= 2 * this.count(i, 53);
    cost += 2 * this.count(i, 24);
    cost -= 5 * this.count(i, 90);
    cost -= 3 * this.count(i, 128);
    return Math.max(0, cost);
  }
  goldDiscardValue(i) { return GOLD_DISCARD[this.s.round - 1] + 6 * this.count(i, 123); }

  // Options légales pour la carte `id` de la main du joueur i
  legalModes(i, id) {
    const c = C(id); const p = this.P(i); const out = [];
    if (c.type === 'action') {
      const cost = this.actionCost(i, id);
      out.push({ mode: 'action', cost, ok: p.gold >= cost });
    } else {
      for (let k = 0; k < 5 && c.type !== 'esquive'; k++) {
        const cost = this.pirateCost(i, id, k);
        out.push({ mode: 'pirate', slot: k, cost, ok: p.gold >= cost });
      }
      for (let k = 0; k < 5; k++) out.push({ mode: 'hidden', slot: k, cost: 0, ok: true });
    }
    out.push({ mode: 'gold', cost: 0, ok: true, gain: this.goldDiscardValue(i) });
    for (const L of this.s.legendsAvail) {
      const cost = this.legendCost(i, L);
      out.push({ mode: 'legend', legend: L, cost, ok: p.gold >= cost });
    }
    return out;
  }

  // ─────────────────────────── navire ───────────────────────────
  discardSlot(i, k, why) {
    const p = this.P(i); const s = p.slots[k]; if (!s) return;
    p.slots[k] = null; p.discard.push(s.card);
    this.log(`${this.nm(i)} défausse ${s.hidden ? 'un pirate face cachée' : C(s.card).name}${why ? ' (' + why + ')' : ''}.`);
  }
  replaceTriggers(i) {
    const r = this.count(i, 9); if (r) this.gainForce(i, 2 * r, 'Recruteuse');
    const a = this.count(i, 127); if (a) this.gainGold(i, 5 * a, 'Anne Bonny');
  }
  // Pose un pirate face visible (sans résoudre placement/effet immédiat). paid = coût réellement payé (null si non « joué »)
  putPirate(i, id, k, { played = true, paid = 0 } = {}) {
    const p = this.P(i);
    let replaced = false;
    if (p.slots[k]) { this.discardSlot(i, k, 'remplacé'); replaced = true; }
    if (replaced) this.replaceTriggers(i);
    p.slots[k] = { card: id, hidden: false };
    this.ev({ type: 'slot', p: i, slot: k });
    if (played) this.playPirateTriggers(i, id, k, paid);
  }
  playPirateTriggers(i, id, k, paid) {
    // Effets permanents des AUTRES pirates déjà en jeu
    const ex = (cid) => this.count(i, cid) - (id === cid ? 1 : 0);
    const well = !!this.icon(i, k);
    if (ex(7)) this.gainGold(i, ex(7), 'Intendante');
    if (ex(122) > 0) this.gainGold(i, 2 * ex(122), 'Edward Low');
    if (paid <= 2 && ex(3)) this.gainGold(i, 3 * ex(3), 'Frère de bordée');
    if (paid <= 5 && ex(49)) this.gainForce(i, 2 * ex(49), 'Meneur des moussaillons');
    if (well && ex(48)) this.gainGold(i, 3 * ex(48), 'Gestionnaire des quartiers');
    if (well && ex(17)) this.gainGold(i, 2 * ex(17), 'Collecteur de dîme');
  }
  async placeLegend(i, L) {
    const p = this.P(i);
    let k = p.legends.indexOf(null);
    if (k < 0) {
      k = await this.ask(i, { kind: 'legend-slot', title: `Quel Pirate légendaire remplacer par ${C(L).name} ?`,
        options: p.legends.map((l, j) => ({ value: j, label: `Remplacer ${C(l).name}`, card: l })) });
      p.discard.push(p.legends[k]);
      this.log(`${this.nm(i)} défausse ${C(p.legends[k]).name}.`);
    }
    p.legends[k] = L;
    this.ev({ type: 'legend', p: i });
    this.s.legendsAvail = this.s.legendsAvail.filter(x => x !== L);
    this.log(`${this.nm(i)} recrute le Pirate légendaire ${C(L).name} !`);
  }

  // Effet de placement de la position k
  async applyPlacement(i, k, { owner = i, times } = {}) {
    const ic = this.icon(owner, k); if (!ic) return;
    const [t, v] = ic;
    const amount = v + this.count(i, 45) + 3 * this.count(i, 126);
    const reps = times ?? (this.has(i, 89) ? 2 : 1);
    const nm = C(this.P(owner).slots[k].card).name;
    this.ev({ type: 'placement', p: owner, slot: k });
    for (let r = 0; r < reps; r++) {
      if (t === 'F') this.gainForce(i, amount, `placement ${nm}`);
      else if (t === 'G') this.gainGold(i, amount, `placement ${nm}`);
      else if (t === 'P') this.gainPG(i, amount, `placement ${nm}`);
    }
  }
  async reapplyAll(i) { for (const k of this.wellPlaced(i)) await this.applyPlacement(i, k); }
  async chooseAndApply(i, n, owner = i, title) {
    const opts = this.pirateOptions(owner, this.wellPlaced(owner));
    if (!opts.length) return;
    const max = Math.min(n, opts.length);
    if (opts.length <= n) { for (const o of opts) await this.applyPlacement(i, o.value, { owner }); return; }
    const sel = await this.ask(i, { kind: 'pick-placements', title: title || `Choisissez ${max} effet(s) de placement à activer`, options: opts.map(o => ({ ...o, label: o.label + ' : ' + this.iconLabel(this.icon(owner, o.value)) })), min: max, max });
    for (const k of sel) await this.applyPlacement(i, k, { owner });
  }
  iconLabel(ic) { if (!ic) return ''; return `+${ic[1]} ${{ F: 'Force', G: 'or', P: 'PG' }[ic[0]]}`; }

  // Joue gratuitement une carte (effet de carte). Pirate → choix de position, placement + effet immédiat.
  async playFree(i, id, why) {
    const c = C(id);
    this.log(`${this.nm(i)} joue gratuitement ${c.type === 'action' ? 'l\'action « ' + c.text + ' »' : c.name} (${why}).`);
    if (c.type === 'action') { await this.resolveAction(i, id, { paid: 0 }); return; }
    if (c.type === 'legend') { await this.placeLegend(i, id); return; }
    const k = await this.ask(i, { kind: 'slot-place', card: id, title: `Où placer ${c.name} ?`, options: this.slotOptions(i) });
    this.putPirate(i, id, k, { paid: 0 });
    await this.applyPlacement(i, k); this.flush();
    if (c.inst) { await this.pirateEffect(i, id, k); this.flush(); }
  }

  // ─────────────────────────── vigie ───────────────────────────
  climb(i) {
    if (this.s.vigieBroken) { this.log('La vigie est cassée : impossible de grimper.'); return; }
    this.climbers.add(i);
  }
  async descend(src) {
    const v = this.s.vigie; if (v == null) return;
    if (await this.affect(src, v, true)) { this.s.vigie = null; this.log(`${this.nm(v)} est forcé de descendre de la vigie.`); }
  }
  resolveClimbs() {
    const cl = [...this.climbers]; this.climbers.clear();
    if (!cl.length || this.s.vigieBroken) return;
    if (cl.length === 1) {
      const q = cl[0];
      if (this.s.vigie !== q) {
        this.s.vigie = q; this.ev({ type: 'vigie', p: q }); this.log(`${this.nm(q)} grimpe sur la vigie !`);
        for (const p of this.s.players) { const k = this.count(p.idx, 125); if (k) this.gainPG(p.idx, 4 * k, 'Benjamin Hornigold'); }
      } else this.log(`${this.nm(q)} est déjà sur la vigie.`);
    } else {
      this.log(`${cl.map(q => this.nm(q)).join(' et ')} grimpent en même temps : personne ne monte.`);
      if (this.s.vigie != null) { this.log(`${this.nm(this.s.vigie)} redescend de la vigie.`); this.s.vigie = null; }
      for (const q of cl) this.gainPG(q, VIGIE_CLASH_PG[this.s.round - 1], 'bousculade à la vigie');
    }
  }

  // ─────────────────────────── effets des pirates (immédiats) ───────────────────────────
  async pirateEffect(i, id, slot) {
    const p = this.P(i); const N = this.others(i);
    switch (id) {
      case 2: this.gainForce(i, 2, 'Cannonnière'); break;
      case 4: { this.gainGold(i, 3, 'Généreuse'); const q = await this.choosePlayer(i, N, 'Qui gagne 1 or ?', false); if (q != null) this.gainGold(q, 1, 'Généreuse'); break; }
      case 5: case 6: {
        const adj = [slot - 1, slot + 1].filter(k => k >= 0 && k < 5 && p.slots[k]).length;
        if (id === 5) this.gainPG(i, 2 * adj, 'Cuisinier jovial'); else this.gainGold(i, 3 * adj, 'Joueuse de cartes');
        break;
      }
      case 11: case 46: await this.descend(i); break;
      case 12: case 13: case 14: case 15: case 57: case 58: case 59: case 60: case 61: case 97: case 98: this.climb(i); break;
      case 99: this.climb(i); this.gainGold(i, 5, 'Vigie'); break;
      case 16: {
        const opts = this.occupied(i).filter(k => k !== slot);
        if (!opts.length) { this.log(`${this.nm(i)} n'a aucun autre pirate à défausser.`); break; }
        const k = await this.ask(i, { kind: 'own-discard', title: 'Revendeur de recrues : quel pirate défausser pour 7 or ?', options: this.pirateOptions(i, opts) });
        this.discardSlot(i, k, 'Revendeur de recrues'); this.gainGold(i, 7, 'Revendeur de recrues');
        break;
      }
      case 19: this.gainForce(i, this.pirateCount(i), 'Chef de meute'); break;
      case 21: if (p.gainedForce) this.gainGold(i, 2, 'Profiteur de bataille'); break;
      case 47: this.gainForce(i, 3, 'Cannonière hyperactive'); break;
      case 50: await this.reapplyAll(i); break;
      case 51: {
        const w = this.wellPlaced(i).length;
        this.gainForce(i, 2 * w, 'Vétéran');
        for (const q of N) this.gainForce(q, w, 'Vétéran adverse');
        break;
      }
      case 55: case 56: {
        if (id === 55) this.gainForce(i, 3, 'Grande généreuse'); else this.gainPG(i, 3, 'Grande généreuse');
        const q = await this.choosePlayer(i, N, 'Quel adversaire gagne 3 or ?', false); if (q != null) this.gainGold(q, 3, 'Grande généreuse');
        break;
      }
      case 62: {
        const best = Math.max(0, ...this.neighbors(i).flatMap(q => this.faceUp(q).map(c => C(c).force || 0)));
        this.gainForce(i, best, 'Capteur de déserteurs'); break;
      }
      case 82: {
        const k = [...p.discard].reverse().find(c => C(c).type === 'action');
        if (k == null) { this.log('Pyromane : aucune action dans la défausse.'); break; }
        p.discard.splice(p.discard.lastIndexOf(k), 1); p.removed.push(k);
        this.log(`${this.nm(i)} rejoue une action de sa défausse (Pyromane), puis la retire du jeu.`);
        await this.resolveAction(i, k, { paid: 0, noDiscard: true });
        break;
      }
      case 83: await this.chooseAndApply(i, 2, i, 'Maître du placement : activez 2 effets de placement'); break;
      case 84: this.gainForce(i, 2 * this.wellPlaced(i).length, 'Maître du placement'); break;
      case 85: {
        this.gainGold(i, 10, 'Racketteur des mers');
        const q = await this.choosePlayer(i, N, 'Quel joueur perd 3 or ?', true);
        if (q != null && await this.affect(i, q)) this.loseGold(q, 3, 'Racketteur des mers');
        break;
      }
      case 86: for (const q of N) if (this.P(q).gold > p.gold && await this.affect(i, q)) this.stealGold(i, q, 3); break;
      case 88: {
        this.loseForce(i, 2, 'Kamikaze glorieux');
        const q = await this.choosePlayer(i, N, 'Quel adversaire perd 6 Force ?', true);
        if (q != null && await this.affect(i, q)) this.loseForce(q, 6, 'Kamikaze glorieux');
        break;
      }
      case 93: this.gainPG(i, Math.floor(p.gold / 2), 'Seigneur du pactole'); break;
      case 94: this.gainForce(i, 2 * Math.floor(p.force / 5), 'Colosse des mers'); break;
      case 95: {
        const q = await this.extreme(i, N, 'force', 'max', "Quel adversaire (le plus de Force) ?", true);
        if (q != null && await this.affect(i, q)) this.stealForce(i, q, 5);
        break;
      }
      case 96: this.gainForce(i, 5, 'Canonnier infernal'); break;
      case 100: {
        this.gainForce(i, 6, 'Tempête humaine');
        const q = await this.choosePlayer(i, N, 'Quel adversaire gagne 2 Force ?', false); if (q != null) this.gainForce(q, 2, 'Tempête humaine');
        break;
      }
      case 101: { const q = await this.choosePlayer(i, N, 'Quel adversaire gagne 4 or ?', false); if (q != null) this.gainGold(q, 4, 'Mentor'); break; }
      default: break;
    }
  }

  // Joueur avec le plus/moins de `stat` parmi cands ; égalité → départage par priorité (Force, or, PG) puis choix
  async extreme(i, cands, stat, dir, title, harmful) {
    if (!cands.length) return null;
    const val = (q) => this.P(q)[stat];
    const target = dir === 'max' ? Math.max(...cands.map(val)) : Math.min(...cands.map(val));
    let tied = cands.filter(q => val(q) === target);
    if (tied.length > 1) {
      const key = (q) => [this.P(q).force, this.P(q).gold, this.P(q).pg];
      tied.sort((a, b) => { const ka = key(a), kb = key(b); for (let j = 0; j < 3; j++) if (kb[j] !== ka[j]) return kb[j] - ka[j]; return 0; });
      const k0 = key(tied[0]);
      tied = tied.filter(q => key(q).every((v, j) => v === k0[j]));
    }
    if (tied.length === 1) return tied[0];
    return this.choosePlayer(i, tied, title + ' (égalité)', harmful);
  }

  // ─────────────────────────── cartes Action ───────────────────────────
  actionTriggers(i, paid) {
    if (paid <= 2 && this.count(i, 3)) this.gainGold(i, 3 * this.count(i, 3), 'Frère de bordée');
    if (this.count(i, 18)) this.gainGold(i, this.count(i, 18), 'Opportuniste');
    if (this.count(i, 121)) this.gainGold(i, 2 * this.count(i, 121), 'Howell Davis');
    if (this.count(i, 44)) this.gainForce(i, this.count(i, 44), 'Opportuniste violente');
  }
  async blackSam(i) {
    for (let r = 0; r < this.count(i, 131); r++) {
      const q = await this.extreme(i, this.others(i), 'force', 'max', 'Black Sam : quel adversaire perd 2 Force ?', true);
      if (q != null && await this.affect(i, q)) this.loseForce(q, 2, 'Black Sam');
    }
  }
  async resolveAction(i, id, { paid = 0, noDiscard = false } = {}) {
    this.actionTriggers(i, paid);
    await this.blackSam(i); this.flush();
    const reps = this.has(i, 87) ? 2 : 1;
    let back = false;
    for (let r = 0; r < reps; r++) {
      if (r === 1) this.log('Pirate écho : l\'action s\'active une deuxième fois.');
      const res = await this.actionEffect(i, id); this.flush();
      if (res === 'back') back = true;
    }
    if (back) { this.s.pioche.splice(Math.floor(Math.random() * (this.s.pioche.length + 1)), 0, id); this.log('La carte est remise au hasard dans la pioche.'); }
    else if (!noDiscard) this.P(i).discard.push(id);
  }

  async actionEffect(i, id) {
    const p = this.P(i); const N = this.others(i);
    const harmT = (t) => this.choosePlayer(i, N, t, true);
    switch (id) {
      case 27: { this.gainForce(i, this.pirateCount(i)); const q = await this.choosePlayer(i, N, 'Qui gagne 1 Force ?', false); if (q != null) this.gainForce(q, 1); break; }
      case 28: {
        const top = [...p.discard].reverse().find(c => C(c).type !== 'legend');
        if (top == null) { this.log('Défausse vide.'); break; }
        p.discard.splice(p.discard.lastIndexOf(top), 1);
        await this.playFree(i, top, 'dessus de la défausse');
        break;
      }
      case 29: {
        const q = await this.extreme(i, this.neighbors(i), 'force', 'min', 'Quel voisin (le moins de Force) ?', true);
        if (q != null && await this.affect(i, q)) { this.stealGold(i, q, 4); this.gainForce(q, 1); }
        break;
      }
      case 30: if (this.s.vigie === i) this.gainPG(i, 3); this.climb(i); break;
      case 31: { const w = this.wellPlaced(i).length; this.gainGold(i, 2 * w); const q = await this.choosePlayer(i, N, `Qui gagne ${w} or ?`, false); if (q != null) this.gainGold(q, w); break; }
      case 32: {
        if (this.s.legendsAvail.length) {
          const L = await this.ask(i, { kind: 'legend-pick', title: 'Choisissez un Pirate légendaire', options: this.s.legendsAvail.map(l => ({ value: l, label: C(l).name, card: l })) });
          await this.placeLegend(i, L);
        } else this.log('Plus aucun Pirate légendaire disponible.');
        this.loseGold(i, p.gold, 'perd tout son or');
        break;
      }
      case 33: this.gainForce(i, 4); break;
      case 34: this.gainForce(i, p.discard.length); break;
      case 35: if (p.force >= 3) this.gainPG(i, 3); else this.log('Pas assez de Force.'); break;
      case 36: if (!this.faceUp(i).some(c => (C(c).force || 0) >= 3)) this.gainForce(i, 3); else this.log('Condition non remplie.'); break;
      case 37: for (const q of N) if (await this.affect(i, q)) this.loseForce(q, 1); this.flush(); this.gainForce(i, 1); break;
      case 38: {
        const c = N.filter(q => p.force > this.P(q).force);
        if (!c.length) { this.log("Personne n'a moins de Force."); break; }
        const q = await harmT('À qui voler 5 or ?');
        if (!c.includes(q)) { this.log('Condition non remplie.'); break; }
        if (await this.affect(i, q)) { this.stealGold(i, q, 5); this.gainForce(q, 2); }
        break;
      }
      case 39: {
        const top = [...p.discard].reverse().find(c => isPirateType(C(c)));
        const occ = this.occupied(i);
        if (top == null || !occ.length) { this.log('Impossible (pas de pirate en défausse ou à remplacer).'); break; }
        const k = await this.ask(i, { kind: 'slot-place', card: top, title: `Quel pirate remplacer par ${C(top).name} ?`, options: this.slotOptions(i, x => occ.includes(x)) });
        p.discard.splice(p.discard.lastIndexOf(top), 1);
        this.putPirate(i, top, k, { paid: 0 });
        await this.applyPlacement(i, k); this.flush();
        if (C(top).inst) { await this.pirateEffect(i, top, k); this.flush(); }
        break;
      }
      case 40: {
        const q = await this.extreme(i, N, 'gold', 'min', "Quel adversaire (le moins d'or) ?", true);
        if (q != null && await this.affect(i, q)) { this.stealForce(i, q, 3); this.gainGold(q, 3); }
        break;
      }
      case 64: for (const q of N) if (this.P(q).pg > p.pg && await this.affect(i, q)) this.stealPG(i, q, 1); break;
      case 65: {
        const c = N.filter(q => this.wellPlaced(q).length);
        if (!c.length) { this.log('Aucun bateau adverse avec des effets de placement.'); break; }
        const q = await this.ask(i, { kind: 'target-copy', title: 'Copier les effets de placement de quel bateau ?', options: c.map(q => ({ value: q, label: this.nm(q) })) });
        await this.chooseAndApply(i, 3, q, `Choisissez jusqu'à 3 effets de placement de ${this.nm(q)}`);
        break;
      }
      case 66: {
        const c = N.filter(q => this.P(q).discard.some(x => C(x).type !== 'legend'));
        if (!c.length) { this.log('Aucune défausse adverse.'); break; }
        const q = await this.ask(i, { kind: 'target-discard', title: 'Jouer le dessus de la défausse de qui ?',
          options: c.map(q => { const top = [...this.P(q).discard].reverse().find(x => C(x).type !== 'legend'); return { value: q, label: `${this.nm(q)} : ${C(top).type === 'action' ? 'Action' : C(top).name}`, card: top }; }) });
        const dq = this.P(q).discard; const top = [...dq].reverse().find(x => C(x).type !== 'legend');
        dq.splice(dq.lastIndexOf(top), 1);
        await this.playFree(i, top, `défausse de ${this.nm(q)}`);
        break;
      }
      case 67: {
        const top = [...p.discard].reverse().find(c => isPirateType(C(c)));
        if (top == null) { this.log('Aucun pirate en défausse.'); break; }
        p.discard.splice(p.discard.lastIndexOf(top), 1);
        await this.playFree(i, top, 'pirate de la défausse');
        break;
      }
      case 68: {
        await this.reapplyAll(i);
        const c = N.filter(q => this.wellPlaced(q).length);
        if (!c.length) break;
        const q = await this.choosePlayer(i, c, 'Quel autre joueur ré-applique 2 effets de placement ?', false);
        if (q != null) await this.chooseAndApply(q, 2, q, 'Ré-appliquez 2 de vos effets de placement');
        break;
      }
      case 69: this.gainForce(i, this.wellPlaced(i).length); break;
      case 70: {
        const q = await this.extreme(i, N, 'force', 'max', 'Quel adversaire (le plus de Force) ?', true);
        if (q != null && await this.affect(i, q)) { this.stealForce(i, q, 4); this.gainGold(q, 4); }
        break;
      }
      case 71: this.gainGold(i, 10); break;
      case 72: for (const q of N) if (await this.affect(i, q)) this.loseForce(q, 1); this.flush(); this.gainForce(i, 2); break;
      case 73: case 112: {
        const big = id === 73 ? 7 : 10, st = id === 73 ? 5 : 7;
        const pool = id === 73 ? N : this.neighbors(i);
        const q = await this.extreme(i, pool, 'force', 'min', 'Quel joueur (le moins de Force) ?', true);
        const canSteal = q != null && (id === 73 || p.force > this.P(q).force);
        const ch = canSteal ? await this.ask(i, { kind: 'option', title: 'Choisissez', options: [{ value: 'gold', label: `Gagner ${big} or` }, { value: 'steal', label: `Voler ${st} or à ${this.nm(q)} (il gagne 2 Force)` }] }) : 'gold';
        if (ch === 'gold') this.gainGold(i, big);
        else if (await this.affect(i, q)) { this.stealGold(i, q, st); this.gainForce(q, 2); }
        break;
      }
      case 74: {
        const c = N.filter(q => p.force > this.P(q).force);
        if (!c.length) { this.log('Condition non remplie.'); break; }
        const q = await this.choosePlayer(i, c, 'Quel joueur (avec moins de Force) gagne 1 Force ?', false);
        this.gainForce(i, 2); this.gainGold(i, 2); this.gainPG(i, 2); this.gainForce(q, 1);
        break;
      }
      case 75: { const q = await harmT('À qui voler 3 PG ?'); if (q != null && await this.affect(i, q)) this.stealPG(i, q, 3); break; }
      case 76: {
        if (!this.s.pioche.length) { this.log('La pioche est vide.'); return 'back'; }
        const d = this.s.pioche.shift();
        this.log(`${this.nm(i)} pioche ${C(d).type === 'action' ? 'une Action' : C(d).name}.`);
        const ce = C(d);
        if (ce.type === 'action') await this.resolveAction(i, d, { paid: 0 });
        else await this.playFree(i, d, 'pioché');
        return 'back';
      }
      case 77: case 117: {
        const opts = N.flatMap(q => this.faceUpSlots(q).map(k => ({ q, k, card: this.P(q).slots[k].card }))).filter(o => this.pirateCost(i, o.card, null) <= p.gold || C(o.card).cost <= p.gold);
        const ok = opts.filter(o => C(o.card).cost <= p.gold);
        if (!ok.length) { this.log('Aucun pirate volable (or insuffisant).'); break; }
        const sel = await this.ask(i, { kind: 'steal-pirate', title: 'Quel pirate voler (vous payez son coût à son propriétaire) ?', options: ok.map((o, j) => ({ value: j, label: `${C(o.card).name} de ${this.nm(o.q)} (${C(o.card).cost} or)`, card: o.card, owner: o.q, slot: o.k })) });
        const o = ok[sel];
        if (!await this.affect(i, o.q)) break;
        const cost = C(o.card).cost;
        this.pay(i, cost, 'vol de pirate'); this.P(o.q).gold += cost; this.ev({ type: 'res', p: o.q, res: 'G', n: cost, why: 'pirate volé' });
        this.P(o.q).slots[o.k] = null;
        this.log(`${this.nm(i)} vole ${C(o.card).name} à ${this.nm(o.q)} pour ${cost} or.`);
        const k = await this.ask(i, { kind: 'slot-place', card: o.card, title: `Où placer ${C(o.card).name} ?`, options: this.slotOptions(i) });
        this.putPirate(i, o.card, k, { played: false });
        await this.applyPlacement(i, k);
        break;
      }
      case 78: {
        const occ = this.occupied(i);
        if (!occ.length) { this.log('Aucun pirate à défausser.'); break; }
        const k = await this.ask(i, { kind: 'own-discard-value', title: 'Quel pirate défausser (gain : 4 × son coût) ?', options: this.pirateOptions(i, occ) });
        const cost = C(p.slots[k].card).cost;
        this.discardSlot(i, k); this.gainGold(i, 4 * cost);
        break;
      }
      case 79: for (const q of N) await this.forceDiscard(q, i, this.occupied(q), 'Défaussez un pirate'); break;
      case 80: this.gainGold(i, 15); this.losePG(i, 2); break;
      case 103: {
        const c = this.neighbors(i).filter(q => this.occupied(q).length);
        if (!c.length) { this.log('Aucun voisin avec un pirate.'); break; }
        const opts = c.flatMap(q => this.occupied(q).map(k => ({ q, k })));
        const sel = await this.ask(i, { kind: 'steal-pirate', title: "Quel pirate prendre chez un voisin ?", options: opts.map((o, j) => { const s = this.P(o.q).slots[o.k]; return { value: j, label: `${s.hidden ? 'Pirate caché' : C(s.card).name} de ${this.nm(o.q)} (pos. ${o.k + 1})`, card: s.hidden ? null : s.card, owner: o.q, slot: o.k }; }) });
        const o = opts[sel];
        if (!await this.affect(i, o.q)) break;
        const taken = this.P(o.q).slots[o.k]; this.P(o.q).slots[o.k] = null;
        const mine = this.occupied(i);
        let given = null, gk = null;
        if (mine.length) {
          gk = await this.ask(i, { kind: 'give-pirate', title: `Quel pirate donner à ${this.nm(o.q)} en échange ?`, options: this.pirateOptions(i, mine) });
          given = p.slots[gk]; p.slots[gk] = null;
        }
        const k = gk != null ? gk : await this.ask(i, { kind: 'slot-place', card: taken.card, title: 'Où placer le pirate pris ?', options: this.slotOptions(i) });
        if (p.slots[k]) this.discardSlot(i, k, 'remplacé');
        p.slots[k] = taken;
        this.log(`${this.nm(i)} prend ${taken.hidden ? 'un pirate caché' : C(taken.card).name} à ${this.nm(o.q)}${given ? ' et lui donne ' + (given.hidden ? 'un pirate caché' : C(given.card).name) : ''}.`);
        await this.applyPlacement(i, k);
        if (given) { this.P(o.q).slots[o.k] = given; await this.applyPlacement(o.q, o.k); }
        break;
      }
      case 104: this.gainGold(i, 5 * this.faceUp(i).filter(c => C(c).type !== 'legend' && C(c).cost >= 4).length); break;
      case 105: this.gainPG(i, 10); break;
      case 106: await this.reapplyAll(i); break;
      case 107: {
        if (this.faceUp(i).some(c => C(c).name === 'Vigie')) this.gainPG(i, 4);
        this.climb(i); break;
      }
      case 108: this.gainGold(i, 15); break;
      case 109: for (const q of N) if (await this.affect(i, q)) this.loseForce(q, 5); break;
      case 110: {
        const m = Math.min(8, p.gold);
        if (m < 1) { this.log('Pas d\'or à échanger.'); break; }
        const n = await this.ask(i, { kind: 'number', title: 'Combien d\'or échanger contre de la Force ?', options: Array.from({ length: m }, (_, k) => ({ value: k + 1, label: `${k + 1}` })) });
        this.loseGold(i, n, 'échange'); this.gainForce(i, n, 'échange');
        break;
      }
      case 111: this.gainPG(i, Math.ceil(p.force / 2)); break;
      case 113: {
        if (this.neighbors(i).some(q => p.force > this.P(q).force)) { this.gainForce(i, 4); this.gainGold(i, 2); this.gainPG(i, 2); }
        else this.log('Condition non remplie.');
        break;
      }
      case 114: {
        const q = await this.extreme(i, N, 'force', 'max', 'Quel adversaire (le plus de Force) perd 3 Force ?', true);
        if (q != null && await this.affect(i, q)) this.loseForce(q, 3);
        this.flush();
        const q2 = await this.extreme(i, N, 'pg', 'max', 'Quel adversaire (le plus de PG) perd 3 PG ?', true);
        if (q2 != null && await this.affect(i, q2)) this.losePG(q2, 3);
        break;
      }
      case 115: {
        if (N.every(q => p.force < this.P(q).force)) { for (const q of N) if (await this.affect(i, q)) this.loseForce(q, 4); }
        else this.log("Vous n'avez pas le moins de Force.");
        break;
      }
      case 116: for (const q of N) {
        const ups = this.faceUpSlots(q); if (!ups.length) continue;
        const mx = Math.max(...ups.map(k => C(this.P(q).slots[k].card).force));
        await this.forceDiscard(q, i, ups.filter(k => C(this.P(q).slots[k].card).force === mx), 'Défaussez votre pirate le plus fort');
      } break;
      case 118: for (const q of N) {
        const ups = this.faceUpSlots(q).filter(k => C(this.P(q).slots[k].card).cost > 4);
        if (!ups.length) continue;
        if (await this.forceDiscard(q, i, ups, 'Défaussez un pirate coûtant plus de 4 or')) this.gainForce(q, 2);
      } break;
      case 119: case 120: {
        const occ = this.occupied(i);
        let sel = [];
        if (occ.length) sel = await this.ask(i, { kind: id === 119 ? 'multi-discard-gold' : 'multi-discard-pg', title: 'Défaussez autant de pirates que vous voulez', options: this.pirateOptions(i, occ), min: 0, max: occ.length });
        let gold = 0;
        for (const k of sel) { gold += C(p.slots[k].card).cost; this.discardSlot(i, k); }
        if (id === 119) this.gainGold(i, gold);
        else this.gainPG(i, 3 * p.slots.filter(s => !s).length);
        break;
      }
      default: this.log('(effet non implémenté)');
    }
  }
  // Le joueur q défausse un pirate parmi `slots` à cause d'une carte de src. Retourne true si défaussé.
  async forceDiscard(q, src, slots, title) {
    if (!slots.length) return false;
    if (src != null && !await this.affect(src, q)) return false;
    const k = await this.ask(q, { kind: 'own-discard', title, options: this.pirateOptions(q, slots) });
    this.discardSlot(q, k);
    return true;
  }

  // ─────────────────────────── déroulement ───────────────────────────
  // resume = true : reprend une partie sauvegardée au début d'une phase de choix (annulation)
  async run(resume = false) {
    let skip = resume;
    for (let r = resume ? this.s.round : 1; r <= 3; r++) {
      if (!skip) await this.setupRound(r);
      for (let t = skip ? this.s.turn : 1; t <= 6; t++) {
        this.s.turn = t;
        if (t > 1 && !skip) this.drawStep();
        skip = false;
        await this.choosePhase();
        await this.resolveTurn();
        await this.endTurn();
      }
      await this.combat();
      if (this.s.phase === 'over') return;
    }
    this.finish();
  }

  async setupRound(r) {
    const s = this.s;
    s.round = r; s.turn = 0; s.phase = 'setup';
    const deck = shuffle(ROUND_CARDS(r));
    for (const p of s.players) { p.hand = deck.splice(0, 5); p.chosen = null; p.ready = false; }
    s.pioche = deck.splice(0, 5 * s.n);
    s.fleau = shuffle(FLEAUX(r))[0];
    s.fleauDef = C(s.fleau).def * s.n; s.fleauHp = C(s.fleau).hp * s.n;
    s.legendsAvail = LEGENDS(r);
    s.combat = null; s.reveal = null;
    this.log(`══ Manche ${r} ══ Fléau : ${C(s.fleau).name} (Défense ${s.fleauDef}, PV ${s.fleauHp}).`);
    for (const p of s.players) if (!p.eliminated) p.gold += 7;
    this.log('Chaque joueur reçoit 7 pièces d\'or.');
    this.update();
  }
  drawStep() { for (const p of this.s.players) if (this.s.pioche.length) p.hand.push(this.s.pioche.shift()); }

  async choosePhase() {
    const s = this.s; s.phase = 'choose';
    if (!this.sim && this.onChooseStart) this.onChooseStart(cloneState(s));
    for (const p of s.players) { p.chosen = null; p.ready = false; p.gainedForce = false; }
    this.update();
    await new Promise(res => {
      this.chooseWaiter = res;
      for (const p of s.players) if (p.isBot) {
        setTimeout(() => this.botChoose(p.idx), this.delay ? 300 + Math.random() * 700 : 0);
      }
      this.checkAllReady();
    });
    this.chooseWaiter = null;
  }
  validChoice(i, ch) {
    const p = this.P(i);
    if (!ch || !p.hand.includes(ch.card)) return false;
    const m = this.legalModes(i, ch.card).find(o => o.mode === ch.mode && (o.slot == null || o.slot === ch.slot) && (o.legend == null || o.legend === ch.legend));
    if (!m) return false;
    if (ch.mode === 'hidden') return true;
    return m.ok;
  }
  setChoice(i, ch) {
    const p = this.P(i);
    if (this.s.phase !== 'choose' || p.ready) return false;
    if (ch && ch.cancel) return false;
    if (!this.validChoice(i, ch)) return false;
    p.chosen = ch; p.ready = true;
    this.update();
    this.checkAllReady();
    return true;
  }
  unsetChoice(i) {
    const p = this.P(i);
    if (this.s.phase !== 'choose' || !p.ready) return;
    p.chosen = null; p.ready = false; this.update();
  }
  checkAllReady() {
    if (this.s.players.every(p => p.ready) && this.chooseWaiter) {
      const w = this.chooseWaiter; this.chooseWaiter = null;
      setTimeout(w, this.delay ? 250 : 0);
    }
  }

  async resolveTurn(only = null) {
    const s = this.s; s.phase = 'resolve';
    const order = only != null ? [only] : this.priority();
    s.reveal = order.map(i => ({ player: i, ...this.P(i).chosen }));
    for (const i of order) { const p = this.P(i); p.hand = p.hand.filter(c => c !== p.chosen.card); }
    this.log(`── Manche ${s.round}, tour ${s.turn} : révélation ──`);
    await this.pause(900);
    const pirates = [], actions = [];
    // 1. Paiements et placements
    for (const i of order) {
      const p = this.P(i); const ch = p.chosen; const c = C(ch.card);
      let mode = ch.mode;
      if (mode === 'pirate') {
        const cost = this.pirateCost(i, ch.card, ch.slot);
        if (p.gold < cost) mode = 'gold';
        else {
          this.pay(i, cost, c.name);
          this.log(`${this.nm(i)} recrute ${c.name} en position ${ch.slot + 1} (${cost} or).`);
          this.putPirate(i, ch.card, ch.slot, { paid: cost });
          pirates.push({ i, card: ch.card, slot: ch.slot });
          this.flush();
        }
      } else if (mode === 'action') {
        const cost = this.actionCost(i, ch.card);
        if (p.gold < cost) mode = 'gold';
        else { this.pay(i, cost, 'Action'); this.log(`${this.nm(i)} joue une Action (${cost} or) : « ${c.text} »`); actions.push({ i, card: ch.card, paid: cost }); }
      } else if (mode === 'hidden') {
        if (p.slots[ch.slot]) { this.discardSlot(i, ch.slot, 'remplacé'); this.replaceTriggers(i); }
        p.slots[ch.slot] = { card: ch.card, hidden: true }; this.ev({ type: 'slot', p: i, slot: ch.slot });
        this.log(`${this.nm(i)} place un pirate face cachée en position ${ch.slot + 1}.`);
      } else if (mode === 'legend') {
        p.discard.push(ch.card);
        const cost = this.legendCost(i, ch.legend);
        if (!s.legendsAvail.includes(ch.legend) || p.gold < cost) {
          this.log(`${C(ch.legend).name} n'est plus disponible pour ${this.nm(i)}.`);
          this.gainGold(i, this.goldDiscardValue(i), 'défausse');
        } else {
          this.pay(i, cost, C(ch.legend).name);
          await this.placeLegend(i, ch.legend);
        }
        mode = 'done';
      }
      if (mode === 'gold') {
        p.discard.push(ch.card);
        this.gainGold(i, this.goldDiscardValue(i), 'défausse');
      }
      await this.pause(450);
    }
    // 2. Effets de placement
    for (const x of pirates) { if (this.P(x.i).slots[x.slot]?.card === x.card) { await this.applyPlacement(x.i, x.slot); this.flush(); await this.pause(450); } }
    // 3. Effets immédiats des pirates
    for (const x of pirates) if (C(x.card).inst && this.P(x.i).slots[x.slot]?.card === x.card) { await this.pirateEffect(x.i, x.card, x.slot); this.flush(); await this.pause(550); }
    // 4. Actions
    for (const x of actions) { await this.resolveAction(x.i, x.card, { paid: x.paid }); this.flush(); await this.pause(650); }
    this.resolveClimbs();
    this.update();
  }

  async endTurn() {
    const s = this.s;
    // Vigie
    if (s.vigie != null) {
      const q = s.vigie;
      const bonus = 2 * this.count(q, 124) + this.count(q, 61) + this.count(q, 97);
      this.gainPG(q, VIGIE_PG[s.round - 1] + bonus, 'vigie');
      const k98 = this.count(q, 98);
      for (let r = 0; r < k98; r++) for (const o of this.others(q)) if (await this.affect(q, o)) this.loseForce(o, 1, 'Vigie');
      this.flush();
    }
    for (const p of s.players) {
      const i = p.idx;
      if (this.count(i, 10) && p.gold <= 2) this.gainForce(i, this.count(i, 10), 'Maître des finances');
      if (this.count(i, 23) && p.gold >= 5) this.gainForce(i, this.count(i, 23), 'Radine');
      if (this.count(i, 129)) this.gainPG(i, 3 * this.count(i, 129), 'Henri Every');
      if (this.count(i, 130)) this.gainForce(i, 3 * this.count(i, 130), 'Amaro Pargo');
    }
    this.flush();
    // Passer les cartes à droite
    if (s.turn < 6) {
      const hands = s.players.map(p => p.hand);
      s.players.forEach((p, i) => { p.hand = hands[this.left(i)]; });
    }
    this.update();
  }

  async combat() {
    const s = this.s; s.phase = 'combat';
    for (const p of s.players) { p.removed.push(...p.hand); p.hand = []; p.chosen = null; }
    s.reveal = null;
    this.log(`── Préparation du combat contre ${C(s.fleau).name} ──`);
    this.update();
    // Révéler ou défausser les pirates face cachée
    for (const i of this.priority()) {
      const p = this.P(i);
      while (p.slots.some(x => x && x.hidden)) {
        const hid = p.slots.map((x, k) => x && x.hidden ? k : -1).filter(k => k >= 0);
        const opts = [];
        for (const k of hid) {
          const id = p.slots[k].card; const cost = this.pirateCost(i, id, k, { reveal: true });
          opts.push({ value: `g${k}`, label: `${C(id).name} (pos. ${k + 1}) : défausser pour ${this.goldDiscardValue(i)} or`, card: id, slot: k });
          if (p.gold >= cost) opts.push({ value: `r${k}`, label: `${C(id).name} (pos. ${k + 1}) : payer ${cost} or et révéler`, card: id, slot: k, cost });
        }
        const ans = await this.ask(i, { kind: 'reveal', title: 'Pirates face cachée : révéler ou défausser ?', options: opts, always: true });
        const k = parseInt(ans.slice(1), 10); const id = p.slots[k].card;
        if (ans[0] === 'g') { p.slots[k] = null; p.discard.push(id); this.gainGold(i, this.goldDiscardValue(i), `défausse de ${C(id).name}`); }
        else {
          const cost = this.pirateCost(i, id, k, { reveal: true });
          this.pay(i, cost, C(id).name); p.slots[k] = null;
          this.log(`${this.nm(i)} révèle ${C(id).name} (${cost} or).`);
          this.putPirate(i, id, k, { paid: cost });
          await this.applyPlacement(i, k); this.flush();
          if (C(id).inst) { await this.pirateEffect(i, id, k); this.flush(); }
        }
        await this.pause(250);
      }
    }
    this.resolveClimbs();
    // Ajout de la Force de l'équipage
    for (const p of s.players) {
      if (p.eliminated) continue;
      let f = this.crewForce(p.idx);
      if (this.has(p.idx, 132)) { f *= 2; }
      p.force += f;
      this.log(`${p.name} ajoute ${f} Force d'équipage${this.has(p.idx, 132) ? ' (doublée par William Fly)' : ''} → ${p.force}.`);
    }
    // Ordre d'attaque : Force > or > moins de PG > hasard
    const ord = s.players.filter(p => !p.eliminated).map(p => ({ p, r: Math.random() }))
      .sort((a, b) => (b.p.force - a.p.force) || (b.p.gold - a.p.gold) || (a.p.pg - b.p.pg) || (a.r - b.r)).map(x => x.p.idx);
    s.combat = { order: ord, current: null, results: [] };
    this.update(); await this.pause(1200);
    for (const i of ord) {
      if (s.fleauHp <= 0) { s.combat.results.push({ i, skipped: true }); this.log(`${this.nm(i)} n'attaque pas : le Fléau est déjà vaincu.`); continue; }
      const p = this.P(i); s.combat.current = i;
      const start = p.force;
      if (p.force < s.fleauDef) {
        p.force = 0;
        s.combat.results.push({ i, start, dmg: 0, fail: true });
        this.log(`${p.name} attaque avec ${start} Force mais ne franchit pas la Défense (${s.fleauDef}).`);
      } else {
        p.force -= s.fleauDef;
        const dmg = Math.min(p.force, s.fleauHp);
        s.fleauHp -= dmg; p.force -= dmg;
        this.log(`${p.name} franchit la Défense et inflige ${dmg} dégâts.`);
        this.gainPG(i, dmg, 'combat');
        if (s.fleauHp > 0) p.force = 0;
        s.combat.results.push({ i, start, dmg, left: p.force });
      }
      await this.pause(1100);
    }
    s.combat.current = null;
    if (s.fleauHp <= 0) this.log(`Le Fléau ${C(s.fleau).name} est vaincu !`);
    else { this.log(`Le Fléau ${C(s.fleau).name} n'est pas vaincu : ${C(s.fleau).text}`); await this.fleauEffect(s.fleau); }
    s.combat.done = true;
    // Fin de manche
    s.pioche = []; s.legendsAvail = [];
    this.update();
    if (s.round < 3) {
      await this.waitContinue();
    }
  }
  // Pause entre deux manches : chaque humain clique « Continuer » (les bots sont toujours prêts)
  async waitContinue() {
    if (this.sim || !this.delay) return;
    const s = this.s; s.phase = 'interlude';
    for (const p of s.players) p.ready = p.isBot;
    this.update();
    await new Promise(res => { this.contWaiter = res; this.checkContinue(); });
  }
  continueReady(i) { if (this.s.phase !== 'interlude') return; this.P(i).ready = true; this.update(); this.checkContinue(); }
  checkContinue() {
    if (this.s.players.every(p => p.ready || p.isBot) && this.contWaiter) { const w = this.contWaiter; this.contWaiter = null; w(); }
  }

  async fleauEffect(id) {
    const s = this.s; const ps = s.players.filter(p => !p.eliminated).map(p => p.idx);
    const order = this.priority();
    switch (id) {
      case 133: for (const i of ps) this.P(i).pg = 0; break;
      case 134: for (const i of order) await this.forceDiscard(i, null, this.occupied(i), 'Chasseurs de pirates : défaussez un pirate'); break;
      case 135: {
        const gifts = [];
        for (const i of order) {
          const occ = this.occupied(i); if (!occ.length) continue;
          const k = await this.ask(i, { kind: 'give-pirate', title: `Guarda Costa : quel pirate donner à ${this.nm(this.left(i))} ?`, options: this.pirateOptions(i, occ) });
          gifts.push({ from: i, to: this.left(i), card: this.P(i).slots[k].card }); this.P(i).slots[k] = null;
        }
        for (const g of gifts) {
          const k = await this.ask(g.to, { kind: 'slot-place', card: g.card, title: `Où placer ${C(g.card).name} (donné par ${this.nm(g.from)}) ?`, options: this.slotOptions(g.to) });
          this.log(`${this.nm(g.from)} donne ${C(g.card).name} à ${this.nm(g.to)}.`);
          this.putPirate(g.to, g.card, k, { played: false });
          await this.applyPlacement(g.to, k); this.flush();
        }
        break;
      }
      case 136: for (const i of ps) this.P(i).gold = 0; break;
      case 137: s.vigieBroken = true; s.vigie = null; break;
      case 138: { const g = s.players.map(p => p.gold); for (const i of ps) this.P(i).gold = 0; for (const i of ps) this.P(this.left(i)).gold += g[i]; break; }
      case 139: for (const i of ps) {
        const ups = this.occupied(i); if (!ups.length) continue;
        const mn = Math.min(...ups.map(k => C(this.P(i).slots[k].card).cost));
        for (const k of ups) if (C(this.P(i).slots[k].card).cost === mn) this.discardSlot(i, k, 'Sirènes');
      } break;
      case 140: for (const i of order) {
        const ups = this.occupied(i); if (!ups.length) continue;
        const mx = Math.max(...ups.map(k => C(this.P(i).slots[k].card).cost));
        await this.forceDiscard(i, null, ups.filter(k => C(this.P(i).slots[k].card).cost === mx), 'Davy Jones : défaussez votre pirate le plus cher');
      } break;
      case 141: s.victoryRule = 'least'; break;
      case 142: for (const i of ps) this.losePG(i, this.P(i).force, 'Kraken'); break;
      case 143: s.victoryRule = 'richest'; break;
      case 144: s.victoryRule = 'megalodon'; break;
    }
    this.update();
  }

  finish() {
    const s = this.s; s.phase = 'over';
    let ps = s.players.filter(p => !p.eliminated);
    let key;
    if (s.victoryRule === 'megalodon') {
      const mx = Math.max(...ps.map(p => p.pg));
      const out = ps.filter(p => p.pg === mx);
      out.forEach(p => { p.eliminated = true; this.log(`Megalodon : ${p.name} est éliminé !`); });
      ps = ps.filter(p => !p.eliminated);
    }
    if (s.victoryRule === 'least') key = (p) => [-p.pg, p.gold];
    else if (s.victoryRule === 'richest') key = (p) => [p.gold, p.pg];
    else key = (p) => [p.pg, p.gold];
    const ranked = [...ps].sort((a, b) => { const ka = key(a), kb = key(b); return (kb[0] - ka[0]) || (kb[1] - ka[1]); });
    const top = ranked[0];
    const winners = top ? ranked.filter(p => key(p)[0] === key(top)[0] && key(p)[1] === key(top)[1]).map(p => p.idx) : [];
    s.result = { winners, rule: s.victoryRule, ranking: [...ranked.map(p => p.idx), ...s.players.filter(p => p.eliminated).map(p => p.idx)] };
    this.log(`🏆 Victoire de ${winners.map(i => this.nm(i)).join(' et ')} !`);
    this.update();
  }

  // ─────────────────────────── vue par joueur (informations cachées) ───────────────────────────
  viewFor(i) {
    const s = this.s;
    const v = JSON.parse(JSON.stringify(s));
    v.me = i;
    v.pioche = s.pioche.length;
    for (const p of v.players) {
      if (p.idx !== i) {
        p.hand = p.hand.length;
        p.slots = p.slots.map(x => x && x.hidden ? { hidden: true, card: null } : x);
        if (s.phase === 'choose') p.chosen = null;
      }
      p.discardCount = p.discard.length;
    }
    if (v.prompt && v.prompt.player !== i) v.prompt = { player: v.prompt.player, title: v.prompt.title, waiting: true };
    if (v.reveal) v.reveal = v.reveal.map(r => (r.mode === 'hidden' && r.player !== i) ? { player: r.player, mode: 'hidden', slot: r.slot } : r);
    if (s.phase === 'choose' && i >= 0) v.modes = Object.fromEntries(s.players[i].hand.map(c => [c, this.legalModes(i, c)]));
    v.log = s.log.slice(-80);
    return v;
  }
}

// Copie profonde d'un état pour simulation
export const cloneState = (s) => JSON.parse(JSON.stringify(s));
