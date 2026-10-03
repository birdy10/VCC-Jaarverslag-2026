// Builds the jaarverslag tables for one season: data/jaarverslag-<year>.json
//   - standings for every competition VCC played in (ResultVault ladders)
//   - batting / bowling / fielding per VCC team
//   - special performances: 50+, 5 wickets, 3+ dismissals, partnerships over 75
// Each table carries named fields per row, so the Google Docs script can fill
// whatever columns a table in the document happens to have.
//
// Usage: node scripts/export-tables.mjs [seasonYear]   (run fetch-data.mjs first)

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const V = require(path.join(ROOT, 'src', 'stats.js'));
const YEAR = process.argv[2] || '2026';
const data = JSON.parse(await fs.readFile(path.join(ROOT, 'data', `season-${YEAR}.json`), 'utf8'));
const S = V.prepare(data);

// ---- names as the jaarverslag writes them: "Lange de, Cedric" ------------------
// Lower-case particles go after the surname ("Lange de, Cedric"); capitalised ones are part of
// it ("Van Vliet, Mees", "Le Noble, Philip").
const LOWER_PARTICLE = /^(van|de|der|den|het|te|ter|ten|'t|op|in)$/;
const UPPER_PARTICLE = /^(Van|De|Der|Den|Ter|Ten|Te|Le|La|Du|Da|Del|Dos)$/;
function listName(pid) {
  // Prefer the API's own "Surname, First" form; it knows multi-word surnames.
  const p = data.players[pid];
  if (p && p[2]) return p[2];
  const full = S.fullName(pid);
  const w = full.split(' ');
  if (w.length < 2) return full;
  let i = w.length - 1;
  while (i > 1 && UPPER_PARTICLE.test(w[i - 1])) i--;
  let j = i;
  while (j > 1 && LOWER_PARTICLE.test(w[j - 1])) j--;
  const first = w.slice(0, j), particles = w.slice(j, i), surname = w.slice(i).join(' ');
  return `${surname}${particles.length ? ' ' + particles.join(' ') : ''}, ${first.join(' ')}`;
}
const dutchDate = ms => { const d = new Date(ms); return `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`; };
const f2 = x => (x == null ? '' : x.toFixed(2));

// ---- per-team tables ----------------------------------------------------------
const tables = [];
const teamTitle = t => `${t.label} – ${t.grade}`;
for (const t of data.teams) {
  const ms = S.matches.filter(m => m.team === t.id && m.played);
  if (!ms.length) continue;
  const r = V.apply(S, { teams: new Set([t.id]), result: 'all', venue: 'all', toss: 'all', side: 'v' });
  const bat = V.batting(r.bat, r.apps).sort((a, b) => b.runs - a.runs || (b.avg ?? -1) - (a.avg ?? -1));
  const bowl = V.bowling(r.bowl).sort((a, b) => b.wkts - a.wkts || (a.avg ?? 1e9) - (b.avg ?? 1e9) || a.runs - b.runs);
  const fld = V.fielding(r.field);
  // Wicketkeeper catches only exist in the API's own fielding records.
  const ctwk = new Map();
  for (const m of ms) for (const inn of m.innings) if (inn.side === 'o') for (const f of inn.field) ctwk.set(f[0], (ctwk.get(f[0]) || 0) + (f[2] || 0));
  const apps = new Map();
  r.apps.forEach(a => { if (!apps.has(a.pid)) apps.set(a.pid, new Set()); apps.get(a.pid).add(a.m.id); });
  const M = pid => (apps.get(pid) || new Set()).size;

  tables.push({
    key: `${t.id}-bat`, team: t.id, kind: 'batting', title: `${teamTitle(t)} · Batting`,
    rows: bat.map((b, i) => ({
      rank: i + 1, name: listName(b.pid), matches: M(b.pid), inn: b.inns, no: b.no, runs: b.runs,
      hs: `${b.hs}${b.hsNo ? '*' : ''}`, avg: f2(b.avg), sr: f2(b.sr), fifties: b.fifties, hundreds: b.hundreds, fours: b.fours, sixes: b.sixes,
    })),
    totals: { name: 'TOTAL', runs: bat.reduce((s, b) => s + b.runs, 0) },
  });
  tables.push({
    key: `${t.id}-bowl`, team: t.id, kind: 'bowling', title: `${teamTitle(t)} · Bowling`,
    rows: bowl.map((b, i) => ({
      rank: i + 1, name: listName(b.pid), overs: b.overs, oversWhole: Math.floor(b.balls / 6), b: b.balls % 6 || '', balls: b.balls,
      maidens: b.maidens, runs: b.runs, wkts: b.wkts, avg: f2(b.avg), econ: f2(b.econ), best: b.best,
    })),
    totals: { name: 'TOTAL', overs: V.toOvers(bowl.reduce((s, b) => s + b.balls, 0)), balls: bowl.reduce((s, b) => s + b.balls, 0), runs: bowl.reduce((s, b) => s + b.runs, 0), wkts: bowl.reduce((s, b) => s + b.wkts, 0) },
  });
  const fRows = fld.filter(f => f.tot > 0).sort((a, b) => b.tot - a.tot || b.ct - a.ct)
    .map((f, i) => ({ rank: i + 1, name: listName(f.pid), m: M(f.pid), ct: f.ct, ctwk: Math.min(f.ct, ctwk.get(f.pid) || 0), st: f.st, ro: f.ro, tot: f.tot }));
  tables.push({
    key: `${t.id}-field`, team: t.id, kind: 'fielding', title: `${teamTitle(t)} · Fielding`, rows: fRows,
    totals: { name: 'Totals', ct: fRows.reduce((s, f) => s + f.ct, 0), st: fRows.reduce((s, f) => s + f.st, 0), ro: fRows.reduce((s, f) => s + f.ro, 0), tot: fRows.reduce((s, f) => s + f.tot, 0) },
  });
}

// ---- special performances, grouped per team ------------------------------------
const all = V.apply(S, { result: 'all', venue: 'all', toss: 'all', side: 'v' });
const byTeam = (rows, map) => data.teams.filter(t => rows.some(x => x.m.team === t.id)).map(t => ({
  team: t.label + (/(T20)/.test(t.grade) ? ' T20' : ''), grade: t.grade,
  rows: rows.filter(x => x.m.team === t.id).sort((a, b) => a.m.date - b.m.date).map(map),
}));
tables.push({ key: 'special-50', kind: 'special', title: 'Batten – 50 runs of meer', groups: byTeam(all.bat.filter(b => b.runs >= 50),
  b => ({ date: dutchDate(b.m.date), opponent: b.m.oppClub, name: S.fullName(b.pid), score: `${b.runs}${b.out ? '' : '*'}` })) });
tables.push({ key: 'special-5w', kind: 'special', title: 'Bowlen – 5 wickets of meer', groups: byTeam(all.bowl.filter(b => b.wkts >= 5),
  b => ({ date: dutchDate(b.m.date), opponent: b.m.oppClub, name: S.fullName(b.pid), score: `${b.wkts}v${b.runs}` })) });
tables.push({ key: 'special-3d', kind: 'special', title: 'Fielden – 3 slachtoffers of meer', groups: byTeam(V.fieldingByMatch(all.field).filter(f => f.tot >= 3),
  f => ({ date: dutchDate(f.m.date), opponent: f.m.oppClub, name: S.fullName(f.pid), score: String(f.tot) })) });
const runsOf = (p, pid) => { const b = S.rows.bat.find(x => x.inn === p.inn && x.pid === pid); return b ? `${b.runs}${b.out ? '' : '*'}` : ''; };
let prevFow = new Map();
tables.push({ key: 'special-p75', kind: 'special', title: `Partnerships >75 runs in ${YEAR}`, groups: byTeam(all.pship.filter(p => p.runs > 75), p => {
  const before = S.rows.pship.filter(x => x.inn === p.inn && x.wkt < p.wkt).reduce((s, x) => s + x.runs, 0);
  return { date: dutchDate(p.m.date), opponent: p.m.oppClub, runs: `${p.approx ? '~' : ''}${p.runs}${p.unbroken ? '*' : ''}`, wkt: p.wkt, from: before, to: before + p.runs,
    by: S.fullName(p.a), byScore: runsOf(p, p.a), and: S.fullName(p.b), andScore: runsOf(p, p.b) };
}) });

// ---- standings --------------------------------------------------------------
const SECRET = '2457FAE695024E20A780B4DE';
const token = () => { const c = crypto.createCipheriv('des-ede3-ecb', Buffer.from(SECRET, 'latin1'), null); return Buffer.concat([c.update(Math.round(Date.now() / 1000 - 60).toString(), 'latin1'), c.final()]).toString('base64'); };
const getJson = async url => {
  const res = await fetch(url, { headers: { 'X-IAS-API-REQUEST': token() } });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
};
const seasons = await getJson('https://api.resultsvault.co.uk/rv/134453/seasons/?apiid=1002');
const seasonId = seasons.find(s => s.season_text.trim() === YEAR).season_id;
for (const gradeId of [...new Set(data.teams.map(t => t.gradeId))]) {
  const teams = data.teams.filter(t => t.gradeId === gradeId && S.matches.some(m => m.team === t.id && m.played));
  if (!teams.length) continue;
  const ladders = await getJson(`https://api.resultsvault.co.uk/rv/134453/ladders/v2/?apiid=1002&gradeid=${gradeId}&seasonid=${seasonId}&sportid=1`);
  if (!Array.isArray(ladders)) { console.warn('  no standings for', teams[0].grade); continue; }
  for (const [li, lad] of ladders.entries()) {
    const col = Object.fromEntries((lad.LadderColumns || []).map(c => [c.col_id, c.heading]));
    for (const [pi0, pool] of (lad.LadderPools || []).entries()) {
      const pi = li ? `${li}-${pi0}` : pi0;
      const rows = (pool.LadderTeams || []).sort((a, b) => a.rank - b.rank).map(t => {
        const v = Object.fromEntries(t.LadderData.map(x => [col[x.id] || x.id, x.val]));
        return { rank: t.rank, club: t.team_name, isVcc: t.entity_id === 134465, played: +v.P || 0, won: +v.W || 0, lost: +v.L || 0,
          points: v.Pts != null ? +(+v.Pts).toFixed(2) : '', nrr: v.NRR != null && v.NRR !== '' ? (+v.NRR).toFixed(2) : '' };
      });
      if (!rows.some(x => x.isVcc)) continue;
      tables.push({ key: `stand-${gradeId}-${pi}`, kind: 'standings', title: `${teams[0].grade}${lad.LadderPools.length > 1 ? ` · ${pool.pool_name || 'poule ' + (pi + 1)}` : ''}`, rows });
    }
  }
}

const out = { season: YEAR, generated: new Date().toISOString(), teams: data.teams.map(t => ({ id: t.id, label: t.label, grade: t.grade })), tables };
const file = path.join(ROOT, 'data', `jaarverslag-${YEAR}.json`);
await fs.writeFile(file, JSON.stringify(out, null, 1));
console.log(`Wrote ${path.relative(ROOT, file)}: ${tables.length} tables (${tables.filter(t => t.kind === 'standings').length} standings)`);
