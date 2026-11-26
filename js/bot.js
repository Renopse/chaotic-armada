// IA des bots : évalue chaque coup possible en le simulant sur une copie de l'état.
import { CARDS } from './cards.js';
import { Game, cloneState } from './engine.js';

const C = (id) => CARDS[id];
const VIGIE_PG = [1, 1, 2];

function horizon(s) {
  const roundsAfter = 3 - s.round;
  const turnsLeft = Math.max(0, 6 - s.turn);
  return { roundsAfter, turnsLeft, total: turnsLeft + 6 * roundsAfter };
}
function goldW(s) { const h = horizon(s); return 0.12 + 0.25 * Math.min(1, h.total / 8); }

function pirateValue(g, i, id, s = g.s) {
  const c = C(id); const h = horizon(s);
  let v = (c.force || 0) * 0.7 * (1 + h.roundsAfter);
  if (!c.inst && c.text) v += 0.3 * h.total;
  if (c.type === 'legend') v += 2 + 0.45 * h.total;
  return v;
}

export function utility(g, i) {
  const s = g.s; const p = g.P(i); const h = horizon(s);
  let v = p.pg + 0.7 * p.force + goldW(s) * p.gold;
  p.slots.forEach((x) => {
    if (!x) return;
    if (x.hidden) {
      const c = C(x.card);
      if (c.type === 'esquive') v += 2;
      else v += 0.9 * Math.max(g.goldDiscardValue(i) * goldW(s), (c.force || 0) * 0.7 * (1 + h.roundsAfter) - c.cost * goldW(s) * 0.5);
    } else v += pirateValue(g, i, x.card);
  });
  p.legends.forEach(l => { if (l) v += pirateValue(g, i, l); });
  if (s.vigie === i) v += VIGIE_PG[s.round - 1] * h.turnsLeft * 0.6;
  if (p.eliminated) v -= 1000;
  return v;
}
function relUtility(g, i) {
  const o = g.s.players.filter(p => p.idx !== i);
  const avg = o.reduce((a, p) => a + utility(g, p.idx), 0) / Math.max(1, o.length);
  return utility(g, i) - 0.3 * avg;
}

// Score « menace » d'un adversaire pour choisir des cibles
const threat = (g, q) => g.P(q).pg + 0.6 * g.P(q).force + 0.1 * g.P(q).gold;

function slotScore(g, i, card, k) {
  const c = C(card); const s = g.s; const p = g.P(i);
  let v = 0;
  const ic = c && c.place ? c.place[k] : null;
  if (ic) {
    const amt = ic[1] + g.count(i, 45) + 3 * g.count(i, 126);
    v += amt * ({ F: 0.7, G: goldW(s), P: 1 }[ic[0]]);
  }
  const occ = p.slots[k];
  if (occ) v -= occ.hidden ? 1.5 : pirateValue(g, i, occ.card) + 0.2;
  return v;
}
function ownPirateKeep(g, i, k) {
  const x = g.P(i).slots[k];
  if (!x) return 0;
  if (x.hidden) return C(x.card).type === 'esquive' ? 2 : 1.5;
  return pirateValue(g, i, x.card);
}

export function botAnswer(g, i, pr) {
  const s = g.s; const opts = pr.options || [];
  const pick = (fn) => { let best = null, bv = -Infinity; for (const o of opts) { const v = fn(o); if (v > bv) { bv = v; best = o; } } return best ? best.value : opts[0]?.value; };
  switch (pr.kind) {
    case 'choose': return botChoose(g, i);
    case 'dodge': return true;
    case 'target-harm': return pick(o => threat(g, o.value) + Math.random() * 0.1);
    case 'target-help': return pick(o => -threat(g, o.value) + Math.random() * 0.1);
    case 'target-copy': return pick(o => g.wellPlaced(o.value).length);
    case 'target-discard': return pick(o => (o.card ? C(o.card).cost : 0));
    case 'slot-place': return pick(o => slotScore(g, i, pr.card, o.value) + Math.random() * 0.01);
    case 'own-discard': case 'give-pirate': return pick(o => -ownPirateKeep(g, i, o.value));
    case 'own-discard-value': return pick(o => 4 * C(g.P(i).slots[o.value].card).cost * goldW(s) - ownPirateKeep(g, i, o.value));
    case 'steal-pirate': return pick(o => o.card ? (C(o.card).force || 0) + (C(o.card).text ? 1 : 0) - C(o.card).cost * goldW(s) * (pr.title.includes('payez') ? 1 : 0) : 1);
    case 'pick-placements': {
      const sc = (o) => { const ic = g.icon(o.owner, o.slot); return ic ? ic[1] * ({ F: 0.7, G: goldW(s), P: 1 }[ic[0]]) : 0; };
      return [...opts].sort((a, b) => sc(b) - sc(a)).slice(0, pr.max).map(o => o.value);
    }
    case 'legend-pick': return pick(o => legendPref(g, i, o.value));
    case 'legend-slot': return pick(o => -legendPref(g, i, o.card));
    case 'option': return opts[0].value;
    case 'number': return opts[opts.length - 1].value;
    case 'multi-discard-gold': return opts.filter(o => { const x = g.P(i).slots[o.value]; return C(x.card).cost * goldW(s) > ownPirateKeep(g, i, o.value) + 0.5; }).map(o => o.value);
    case 'multi-discard-pg': {
      const free = g.P(i).slots.filter(x => !x).length;
      const cand = opts.map(o => ({ o, k: ownPirateKeep(g, i, o.value) })).sort((a, b) => a.k - b.k);
      const out = []; for (const c of cand) if (c.k < 3) out.push(c.o.value); return free + out.length > 0 ? out : [];
    }
    case 'reveal': return pick(o => {
      const k = o.slot; const c = C(o.card);
      if (o.value[0] === 'g') return g.goldDiscardValue(i) * goldW(s) + 0.01;
      const ic = c.place ? c.place[k] : null;
      return (c.force || 0) * 0.7 * (1 + horizon(s).roundsAfter) + (ic ? ic[1] * 0.8 : 0) + (c.inst ? 1.5 : 0) + (c.text && !c.inst ? 1 : 0) - (o.cost || 0) * goldW(s);
    });
    default: return Array.isArray(opts) && pr.max ? [] : opts[0]?.value;
  }
}

function legendPref(g, i, L) {
  const p = g.P(i);
  const pref = { 121: 3, 122: 3, 123: 4, 124: g.s.vigie === i ? 5 : 2, 125: 3, 126: 2 + g.wellPlaced(i).length, 127: 3, 128: 4, 129: 6, 130: 5, 131: 3, 132: 1 + g.crewForce(i) * 0.6 };
  return (pref[L] || 3) - (p.legends.filter(Boolean).length >= 2 ? 0 : 0);
}

// Choix de la carte à jouer : simulation de chaque option possible
export async function botChoose(g, i) {
  const p = g.P(i);
  const cands = [];
  for (const card of p.hand) {
    const modes = g.legalModes(i, card);
    let hiddenDone = false;
    for (const m of modes) {
      if (m.mode !== 'hidden' && !m.ok) continue;
      if (m.mode === 'hidden') {
        if (hiddenDone) continue;
        // une seule position face cachée : la meilleure (vide de préférence)
        const k = [0, 1, 2, 3, 4].sort((a, b) => ownPirateKeep(g, i, a) - ownPirateKeep(g, i, b))[0];
        cands.push({ card, mode: 'hidden', slot: k }); hiddenDone = true; continue;
      }
      cands.push({ card, mode: m.mode, slot: m.slot, legend: m.legend });
    }
  }
  const base = relUtility(g, i);
  let best = null, bv = -Infinity;
  for (const ch of cands) {
    let v;
    try {
      const st = cloneState(g.s);
      const sg = new Game(st, { sim: true, botAnswer });
      sg.P(i).chosen = ch;
      await sg.resolveTurn(i);
      sg.flush();
      v = relUtility(sg, i) - base;
    } catch (e) { v = -999; }
    // valeur de la carte pour un adversaire (on évite de lui passer une bonne carte) : non modélisé
    v += Math.random() * 0.35;
    if (v > bv) { bv = v; best = ch; }
  }
  if (!best) best = { card: p.hand[0], mode: 'gold' };
  return best;
}
