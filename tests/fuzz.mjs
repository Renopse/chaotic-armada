import { Game, newGameState } from '../js/engine.js';
import { botAnswer } from '../js/bot.js';
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
function randAnswer(g, i, pr) {
  if (pr.kind === 'choose') {
    const p = g.P(i); const opts = [];
    for (const c of p.hand) for (const m of g.legalModes(i, c)) if (m.ok || m.mode === 'hidden') opts.push({ card: c, mode: m.mode, slot: m.slot, legend: m.legend });
    return rnd(opts);
  }
  if (pr.max) return pr.options.filter(() => Math.random() < 0.5).slice(0, pr.max).concat([]).slice(0, Math.max(pr.min || 0, 0)).length >= (pr.min||0) ? pr.options.slice(0, pr.min || Math.floor(Math.random()*(pr.max+1))).map(o=>o.value) : [];
  return rnd(pr.options).value;
}
const N = parseInt(process.argv[2] || '100'); let errors = 0; const msgs = new Map(); const used = new Set();
for (let g = 0; g < N; g++) {
  const n = 3 + (g % 2); const random = g % 2 === 0;
  const st = newGameState(Array.from({ length: n }, (_, i) => ({ name: 'B' + i, isBot: true })));
  const game = new Game(st, { botAnswer: random ? randAnswer : botAnswer, delay: 0 });
  const origLog = game.log.bind(game); game.log = (m) => { origLog(m); if (m.includes('non implémenté')) msgs.set(m, (msgs.get(m)||0)+1); };
  try { await game.run(); if (st.phase !== 'over') throw new Error('not over'); 
    for (const p of st.players) { if (p.gold < 0 || p.force < 0 || p.pg < 0) throw new Error('negative ' + JSON.stringify([p.gold,p.force,p.pg])); }
  } catch (e) { errors++; if (errors < 5) { console.log('ERR', random, e.stack.split('\n').slice(0, 5).join('\n')); console.log(st.log.slice(-6).join('\n')); } }
}
console.log('games', N, 'errors', errors, [...msgs]);
