// Vérifie que l'application reconnaît les colonnes de fichiers aux intitulés et formats différents.
// Usage : node tests/test_import.js
const path = require('path'), fs = require('fs');
const Core = require(path.join(__dirname, '..', 'app', 'core.js'));
const dir = path.join(__dirname, '..', 'data', 'exemples');
let ok = true;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort()) {
  const P = Core.parseCSV(fs.readFileSync(path.join(dir, f), 'utf8')), map = Core.guessMapping(P.head);
  const miss = ['cust', 'inv', 'due', 'amt', 'settled'].filter(k => !map[k]);
  let msg;
  if (miss.length) { ok = false; msg = 'ÉCHEC  colonnes obligatoires non reconnues : ' + miss.join(', '); }
  else {
    const N = Core.normalize(P.rows, map), idx = Core.buildIndex(N.rows);
    const last = N.rows.reduce((a, r) => Math.max(a, r.inv), -Infinity);
    try { const m = Core.trainAt(N.rows, idx, last); msg = `OK    ${P.head.length} colonnes, ${N.rows.length} factures, ${N.errors.length} rejetées, modèle sur ${m.n} factures`; }
    catch (e) { ok = false; msg = 'ÉCHEC  ' + e.message; }
  }
  console.log(f.padEnd(42) + msg);
}
process.exit(ok ? 0 : 1);
