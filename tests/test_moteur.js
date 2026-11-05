// Vérifie que le moteur JavaScript de l'application redonne les résultats de l'analyse Python.
// Usage : node tests/test_moteur.js
const path = require('path'), fs = require('fs');
const Core = require(path.join(__dirname, '..', 'app', 'core.js'));
const P = Core.parseCSV(fs.readFileSync(path.join(__dirname, '..', 'data', 'ibm_accounts_receivable.csv'), 'utf8'));
const N = Core.normalize(P.rows, Core.guessMapping(P.head));
const rows = N.rows, idx = Core.buildIndex(rows);
const cut = Core.dayNum(2013, 7, 1), end = Core.dayNum(2013, 11, 25);
const m = Core.trainAt(rows, idx, cut);
const H = {}; for (const l of fs.readFileSync(path.join(__dirname, '..', 'results', 'horizons.csv'), 'utf8').trim().split('\n').slice(1)) { const c = l.split(','); H[c[1] + '_' + c[2].split(' ')[0]] = c; }
let ok = true; const check = (nom, a, b, tol) => { const pass = Math.abs(a - b) <= tol; ok = ok && pass; console.log((pass ? 'OK  ' : 'ÉCHEC') + '  ' + nom + ' : ' + a.toFixed(3) + ' (attendu ' + (+b).toFixed(3) + ')'); };
check('factures d’apprentissage', m.n, 1647, 0);
const te = rows.filter(r => r.inv >= cut);
const p = te.map(r => Core.prob(m, Core.features(r, r.inv, idx, m.pr))), y = te.map(r => r.settled > r.due ? 1 : 0);
check('AUC sur les factures de test', Core.auc(p, y), 0.863, 0.001);
for (const a of [0, 7, 14, 21]) for (const f of [0.2, 0.3]) {
  const R = Core.backtest(rows, idx, m, cut, end, a, f), s = k => R.reduce((x, r) => x + r[k], 0), T = s('tot');
  const ref = H[a + '_' + Math.round(f * 100)];
  check(`X, échéance dans ${a}-${a + 6} j, ${f * 100} %`, s('X') / T, +ref[7], 0.0005);
  check(`Z, échéance dans ${a}-${a + 6} j, ${f * 100} %`, s('Z1') / T, +ref[5], 0.0005);
}
console.log(ok ? '\nTous les contrôles sont passés.' : '\nCertains contrôles ont échoué.'); process.exit(ok ? 0 : 1);
