/* ===== Moteur de scoring du risque de retard de paiement =====
   Même méthode que l'analyse Python (analysis.py) :
   - variables calculées à une date t avec uniquement les factures du client réglées avant t
   - régression logistique L2 (C = 1), variables standardisées
   - apprentissage sur les factures dont l'échéance est antérieure de plus de 46 jours à la date d'observation */
const Core = (() => {
  const DAY = 86400000;
  const K = 3;          // lissage des taux du client
  const GAP = 46;       // jours après l'échéance pour considérer l'issue d'une facture comme connue
  const FEATS = ['hist_n', 'hist_late_rate', 'hist_mean_dayslate', 'hist_disp_rate', 'last_late', 'log_amount', 'amount_vs_cust', 'elec', 'open_others'];

  // ---------- dates (jours entiers UTC) ----------
  function dayNum(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / DAY); }
  function parseDate(s, order) {
    if (s === null || s === undefined) return null;
    s = String(s).trim(); if (!s) return null;
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) return dayNum(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      const a = +m[1], b = +m[2];
      if (order === 'mdy') return dayNum(y, a, b);
      return dayNum(y, b, a); // jj/mm/aaaa par défaut
    }
    return null;
  }
  function fmt(dn) { if (dn === null || dn === undefined || !isFinite(dn)) return ''; const d = new Date(dn * DAY); return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear(); }
  function iso(dn) { const d = new Date(dn * DAY); return d.toISOString().slice(0, 10); }

  // ---------- CSV ----------
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delim = (first.split(';').length > first.split(',').length) ? ';' : (first.split('\t').length > first.split(',').length ? '\t' : ',');
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    const head = rows.shift().map(h => h.trim());
    return { head, rows: rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] !== undefined ? r[i].trim() : '']))), delim };
  }
  const ALIASES = {
    cust: ['customerid', 'client', 'idclient', 'clientid', 'codeclient', 'numeroclient', 'customer', 'tiers', 'compteclient'],
    id: ['invoicenumber', 'invoiceid', 'invoiceno', 'facture', 'numerofacture', 'nfacture', 'nofacture', 'idfacture', 'invoice', 'piece', 'reference'],
    inv: ['invoicedate', 'issuedate', 'datefacture', 'datedefacture', 'dateemission', 'datedemission', 'date'],
    due: ['duedate', 'echeance', 'dateecheance', 'datedecheance', 'datelimite'],
    amt: ['invoiceamount', 'invoiceamounteur', 'amounteur', 'montant', 'montantttc', 'montantht', 'montanteur', 'amount', 'ttc'],
    settled: ['settleddate', 'paymentdate', 'paiddate', 'datepaid', 'paidon', 'settlementdate', 'clearingdate', 'datereglement', 'datedereglement', 'datepaiement', 'datedepaiement', 'reglement', 'dateencaissement', 'datelettrage'],
    disp: ['disputed', 'dispute', 'disputeflag', 'litige', 'enlitige', 'litigeflag', 'contestee', 'contestation'],
    elec: ['paperlessbill', 'invoiceformat', 'dematerialisee', 'electronique', 'facturedematerialisee', 'support', 'format']
  };
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  function guessMapping(head) {
    const map = {}, used = new Set();
    for (const [k, al] of Object.entries(ALIASES)) {
      const h = head.find(h => !used.has(h) && al.includes(norm(h))) || head.find(h => !used.has(h) && al.some(a => a.length > 4 && norm(h).includes(a)));
      map[k] = h || ''; if (h) used.add(h);
    }
    return map;
  }
  function guessOrder(values) { // mdy si un premier nombre > 12 n'apparaît jamais mais un second > 12 oui
    let firstBig = 0, secondBig = 0;
    for (const v of values) { const m = String(v).match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.]/); if (m) { if (+m[1] > 12) firstBig++; if (+m[2] > 12) secondBig++; } }
    return (secondBig > 0 && firstBig === 0) ? 'mdy' : 'dmy';
  }
  const yes = v => { const s = norm(String(v || '')); return ['yes', 'oui', '1', 'true', 'vrai', 'o', 'y', 'electronic', 'electronique', 'dematerialisee', 'pdf', 'facturx'].includes(s); };
  function toNumber(v) { if (v === null || v === undefined) return NaN; let s = String(v).replace(/\s|€|\$/g, ''); if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.'); else s = s.replace(/,/g, ''); return parseFloat(s); }

  function normalize(raw, map) {
    const order = guessOrder(raw.slice(0, 400).flatMap(r => [r[map.inv], r[map.due]]));
    const out = [], errors = [];
    raw.forEach((r, i) => {
      const inv = parseDate(r[map.inv], order), due = parseDate(r[map.due], order), amt = toNumber(r[map.amt]);
      if (inv === null || due === null || !isFinite(amt) || !r[map.cust]) { errors.push(i + 2); return; }
      const st = map.settled ? parseDate(r[map.settled], order) : null;
      out.push({ id: map.id ? r[map.id] : String(i + 1), cust: r[map.cust], inv, due, amt, settled: st,
        disp: map.disp ? (yes(r[map.disp]) ? 1 : 0) : 0, elec: map.elec ? (yes(r[map.elec]) ? 1 : 0) : 0, idx: out.length });
    });
    return { rows: out, errors, order };
  }

  // ---------- index par client ----------
  function buildIndex(rows) {
    const by = new Map();
    for (const r of rows) { if (!by.has(r.cust)) by.set(r.cust, []); by.get(r.cust).push(r); }
    const idx = new Map();
    for (const [c, list] of by) {
      const settled = list.filter(r => r.settled !== null).sort((a, b) => a.settled - b.settled || a.idx - b.idx);
      const n = settled.length, S = { t: [], late: [0], dl: [0], disp: [0], amt: [0] };
      settled.forEach((r, i) => {
        const dl = Math.max(0, r.settled - r.due);
        S.t.push(r.settled); S.late.push(S.late[i] + (dl > 0 ? 1 : 0)); S.dl.push(S.dl[i] + dl); S.disp.push(S.disp[i] + r.disp); S.amt.push(S.amt[i] + r.amt);
      });
      idx.set(c, { all: list, settled, S });
    }
    return idx;
  }
  function countBefore(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; } return lo; }

  function features(r, t, index, pr) {
    const c = index.get(r.cust); const S = c.S; const n = countBefore(S.t, t);
    const late = S.late[n], dl = S.dl[n], disp = S.disp[n], amtS = S.amt[n];
    const lastLate = n ? ((c.settled[n - 1].settled - c.settled[n - 1].due) > 0 ? 1 : 0) : pr.late;
    let open = 0;
    for (const o of c.all) if (o !== r && o.inv <= t && (o.settled === null || o.settled >= t)) open++;
    return [Math.log1p(n), (late + K * pr.late) / (n + K), (dl + K * pr.dl) / (n + K), (disp + K * pr.disp) / (n + K), lastLate,
      Math.log(Math.max(r.amt, 0.01)), n ? r.amt / (amtS / n) : 1, r.elec, open];
  }
  // lecture humaine des principaux facteurs
  function explain(f, model) {
    const z = f.map((v, j) => (v - model.mean[j]) / model.scale[j] * model.w[j]);
    const lab = ['Peu d’historique', 'Taux de retard passé du client', 'Retard moyen passé du client', 'Litiges passés du client', 'Dernière facture payée en retard', 'Montant élevé', 'Montant inhabituel pour ce client', 'Facture électronique', 'Autres factures ouvertes du client'];
    return z.map((v, j) => ({ j, v, lab: lab[j] })).filter(o => o.v > 0.15).sort((a, b) => b.v - a.v).slice(0, 2).map(o => o.lab);
  }

  // ---------- régression logistique L2 (Newton) ----------
  function solve(A, b) {
    const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < n; i++) {
      let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
      [M[i], M[p]] = [M[p], M[i]];
      for (let k = i + 1; k < n; k++) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return x;
  }
  const sig = z => 1 / (1 + Math.exp(-z));
  function fitLR(X, y, C = 1) {
    const n = X.length, d = X[0].length;
    const mean = new Array(d).fill(0), scale = new Array(d).fill(0);
    X.forEach(r => r.forEach((v, j) => mean[j] += v / n));
    X.forEach(r => r.forEach((v, j) => scale[j] += (v - mean[j]) ** 2 / n));
    for (let j = 0; j < d; j++) { scale[j] = Math.sqrt(scale[j]); if (scale[j] < 1e-12) scale[j] = 1; }
    const Z = X.map(r => r.map((v, j) => (v - mean[j]) / scale[j]));
    let w = new Array(d + 1).fill(0); // w[d] = constante
    for (let it = 0; it < 50; it++) {
      const g = new Array(d + 1).fill(0), Hm = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
      for (let i = 0; i < n; i++) {
        const zi = Z[i]; let s = w[d]; for (let j = 0; j < d; j++) s += w[j] * zi[j];
        const p = sig(s), e = C * (p - y[i]), h = C * p * (1 - p);
        for (let j = 0; j <= d; j++) { const a = j < d ? zi[j] : 1; g[j] += e * a; for (let k = 0; k <= j; k++) { const bb = k < d ? zi[k] : 1; Hm[j][k] += h * a * bb; } }
      }
      for (let j = 0; j < d; j++) { g[j] += w[j]; Hm[j][j] += 1; }
      for (let j = 0; j <= d; j++) for (let k = j + 1; k <= d; k++) Hm[j][k] = Hm[k][j];
      const step = solve(Hm, g); let mx = 0;
      w = w.map((v, j) => { mx = Math.max(mx, Math.abs(step[j])); return v - step[j]; });
      if (mx < 1e-10) break;
    }
    return { w: w.slice(0, d), b: w[d], mean, scale };
  }
  function prob(model, f) { let s = model.b; for (let j = 0; j < f.length; j++) s += model.w[j] * (f[j] - model.mean[j]) / model.scale[j]; return sig(s); }

  // ---------- apprentissage à une date d'observation ----------
  function labelAt(r, date) { // issue connue à la date d'observation ?
    if (r.settled !== null && r.settled <= date) return { y: r.settled > r.due ? 1 : 0, dl: Math.max(0, r.settled - r.due) };
    if (r.due < date) return { y: 1, dl: date - r.due }; // échue et non réglée : en retard (au moins)
    return null;
  }
  function trainAt(rows, index, date, opts = {}) {
    const gap = opts.gap ?? GAP;
    const tr = rows.filter(r => r.due < date - gap && r.inv <= date);
    if (tr.length < 50) throw new Error('Historique insuffisant : il faut au moins 50 factures dont l’échéance date de plus de ' + gap + ' jours avant la date d’observation (trouvé : ' + tr.length + ').');
    const lab = tr.map(r => labelAt(r, date));
    const y = lab.map(l => l.y);
    const pr = { late: y.reduce((a, b) => a + b, 0) / y.length, dl: lab.reduce((a, l) => a + l.dl, 0) / y.length, disp: tr.reduce((a, r) => a + r.disp, 0) / tr.length };
    if (pr.late === 0 || pr.late === 1) throw new Error('L’historique ne contient que des factures ' + (pr.late ? 'en retard' : 'à l’heure') + ' : impossible d’apprendre.');
    // pour l'apprentissage, l'historique ne doit contenir que des règlements antérieurs à la date d'observation
    const view = opts.view || index;
    const X = tr.map(r => features(r, r.inv, view, pr));
    const model = fitLR(X, y);
    model.pr = pr; model.n = tr.length; model.lateRate = pr.late; model.date = date;
    return model;
  }
  // index « vu à la date d » : on masque les règlements postérieurs à d (pas d'information du futur)
  function viewAt(rows, date) {
    const vis = rows.filter(r => r.inv <= date).map(r => ({ ...r, settled: (r.settled !== null && r.settled <= date) ? r.settled : null, _orig: r }));
    return { rows: vis, index: buildIndex(vis) };
  }

  // ---------- AUC ----------
  function auc(p, y) {
    const a = p.map((v, i) => [v, y[i]]).sort((u, v) => u[0] - v[0]);
    let rank = 0, sumPos = 0, nPos = 0, i = 0;
    while (i < a.length) { let j = i; while (j < a.length && a[j][0] === a[i][0]) j++; const r = (i + 1 + j) / 2; for (let k = i; k < j; k++) if (a[k][1]) { sumPos += r; nPos++; } i = j; }
    const nNeg = a.length - nPos; if (!nPos || !nNeg) return NaN;
    return (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
  }
  const roundHalfEven = x => { const f = Math.floor(x), d = x - f; if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1; return Math.round(x); };

  // ---------- test X contre Z sur instantanés hebdomadaires ----------
  function backtest(rows, index, model, start, end, a, frac) {
    const res = []; const late = r => r.settled !== null ? (r.settled > r.due ? 1 : 0) : (r.due < end ? 1 : null);
    for (let t = start; t <= end; t += 7) {
      const op = rows.filter(r => r.inv <= t && (r.settled === null || r.settled >= t) && r.due >= t + a && r.due < t + a + 7).filter(r => late(r) !== null);
      if (!op.length) continue;
      op.forEach(r => { r._p = prob(model, features(r, t, index, model.pr)); r._ra = r._p * r.amt; r._y = late(r); });
      const N = Math.max(1, roundHalfEven(frac * op.length));
      const val = s => s.slice(0, N).reduce((acc, r) => acc + r.amt * r._y, 0);
      const z1 = [...op].sort((u, v) => u.due - v.due || v.amt - u.amt || u.idx - v.idx);
      const z2 = [...op].sort((u, v) => v.amt - u.amt || u.idx - v.idx);
      const x = [...op].sort((u, v) => v._ra - u._ra || u.idx - v.idx);
      res.push({ t, n: op.length, nl: op.reduce((s, r) => s + r._y, 0), tot: op.reduce((s, r) => s + r.amt * r._y, 0), N, Z1: val(z1), Z2: val(z2), X: val(x) });
    }
    return res;
  }

  return { DAY, GAP, FEATS, parseDate, fmt, iso, parseCSV, guessMapping, normalize, buildIndex, features, explain, fitLR, prob, trainAt, viewAt, labelAt, auc, backtest, dayNum, roundHalfEven };
})();
if (typeof module !== 'undefined') module.exports = Core;
