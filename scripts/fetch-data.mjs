// Fetches every VCC match of a season from the KNCB Matchcentre (ResultVault API)
// and writes a compact dataset to data/season-<year>.json.
//
// Usage: node scripts/fetch-data.mjs [seasonYear] [--refresh]   (default 2026)
// Raw scorecards are cached in cache/; finished matches are never fetched twice,
// unless --refresh is given: then every scorecard is downloaded again (to pick up corrections).
// Each run compares the result with the previous data file and keeps a log of what changed,
// and lists gaps and inconsistencies in the Matchcentre scorecards.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.resultsvault.co.uk/rv/134453';
const APIID = 1002;
const CLUB_ENTITY_ID = 134465; // VCC
const SHARED_SECRET = '2457FAE695024E20A780B4DE'; // public, embedded in matchcentre.kncb.nl
const ARGS = process.argv.slice(2);
const SEASON_YEAR = ARGS.find(a => !a.startsWith('--')) || '2026';
const REFRESH = ARGS.includes('--refresh');

// Same scheme as the Matchcentre site: base64(3DES-ECB(unix seconds - 60)).
function authToken() {
  const c = crypto.createCipheriv('des-ede3-ecb', Buffer.from(SHARED_SECRET, 'latin1'), null);
  const plain = Math.round(Date.now() / 1000 - 60).toString();
  return Buffer.concat([c.update(plain, 'latin1'), c.final()]).toString('base64');
}

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'X-IAS-API-REQUEST': authToken(), 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise(res => setTimeout(res, 800 * i));
    }
  }
}

const msDate = s => (s ? Number(/Date\((-?\d+)/.exec(s)?.[1]) : null);

async function cached(file, fetcher, reuse) {
  try {
    const hit = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!REFRESH && reuse(hit)) return hit;
  } catch {}
  const fresh = await fetcher();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(fresh));
  return fresh;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---- team naming --------------------------------------------------------------
const GROUPS = [
  [/women|vrouwen|dames|inspire/i, 'Women'],
  [/^U\d|youth|jeugd/i, 'Youth'],
  [/friendl|cup|slotdag/i, 'Cups & friendlies'],
  [/./, 'Senior'],
];
const groupOf = grade => GROUPS.find(([re]) => re.test(grade))[1];

// The first XI is listed as plain "VCC"; number it like the others.
const teamLabel = teamName => (teamName.trim() === 'VCC' ? 'VCC 1' : teamName.trim());

// ---- main ---------------------------------------------------------------------
const seasons = await get(`${API}/seasons/?apiid=${APIID}`);
const season = seasons.find(s => s.season_text.trim() === SEASON_YEAR);
if (!season) throw new Error(`Season ${SEASON_YEAR} not found`);
const grades = await get(`${API}/grades/?apiid=${APIID}&seasonId=${season.season_id}`);
console.log(`Season ${SEASON_YEAR} (id ${season.season_id}): ${grades.length} grades${REFRESH ? ', downloading every scorecard again' : ''}`);

const listings = await pool(grades, 6, async g => {
  try {
    return await get(`${API}/matches/?apiid=${APIID}&seasonid=${season.season_id}&gradeid=${g.grade_id}&action=ors&maxrecs=1000&strmflg=1`);
  } catch (e) { console.warn('  skip grade', g.grade_name, e.message); return []; }
});

const teams = new Map();
const wanted = [];
grades.forEach((g, gi) => {
  for (const m of listings[gi]) {
    const mt = (m.MatchTeams || []).find(t => t.entity_id === CLUB_ENTITY_ID);
    if (!mt) continue;
    const teamId = `${g.grade_id}-${mt.team_number}`;
    if (!teams.has(teamId)) {
      teams.set(teamId, {
        id: teamId, label: teamLabel(mt.team_name), teamName: mt.team_name,
        grade: g.grade_name.trim(), gradeId: g.grade_id, group: groupOf(g.grade_name),
        overs: m.MatchConfig?.max_overs ?? null, sort: g.sort_order ?? 999,
      });
    }
    wanted.push({ listing: m, teamId });
  }
});
console.log(`${wanted.length} VCC matches in ${teams.size} teams`);

const isFinal = d => d && d.status_id >= 50 || (d && d.MatchTeams?.every(t => t.result_flag));
const details = await pool(wanted, 6, async ({ listing }) => {
  const played = (listing.MatchTeams || []).some(t => (t.Innings || []).length);
  if (!played) return null;
  return cached(path.join(ROOT, 'cache', SEASON_YEAR, `${listing.match_id}.json`),
    () => get(`${API}/matches/${listing.match_id}/?apiid=${APIID}&strmflg=1`),
    hit => isFinal(hit));
});

// ---- name clean-up ------------------------------------------------------------
// ResultVault stores Dutch particles after the surname ("Floris Lange de") and abbreviates
// some ("Floris v Hoogdalem", "Sd Graaff"). Put them back where Dutch readers expect them.
const PARTICLE = { d: 'de', v: 'van', vd: 'van de', vdr: 'van der', vden: 'van den', t: "'t" };
const isParticle = w => /^(van|de|der|den|het|te|ter|ten|op|in|'t|v|d|vd|vdr|vden)$/.test(w);
function fixName(name, isShort) {
  if (!name) return name;
  let w = name.trim().split(/\s+/);
  // Short names only ("Sd Graaff", "Fv Hoogdalem"): initials with a glued lower-case particle.
  // Not on full names, where "Ad" is a first name.
  const glued = isShort && /^([A-Z]+)(d|v|vd|vdr|vden|t)$/.exec(w[0]);
  // "ALEXANDER" -> "Alexander"; initials ("BJA") stay as they are in short names.
  if (!isShort) w = w.map(x => (/^[A-Z]{3,}$/.test(x) ? x[0] + x.slice(1).toLowerCase() : x));
  if (glued && w.length > 1) w = [glued[1], glued[2], ...w.slice(1)];
  // trailing particles move in front of the surname: "Floris Lange de" -> "Floris de Lange"
  const tail = [];
  while (w.length > 2 && isParticle(w[w.length - 1])) tail.unshift(w.pop());
  if (tail.length) w.splice(w.length - 1, 0, ...tail);
  return w.map((x, i) => (i > 0 && PARTICLE[x] ? PARTICLE[x] : x)).join(' ');
}
// Club names as VCC writes them.
const RENAMES = [[/Groen Geel/g, 'Groen-Geel']];
const rename = s => RENAMES.reduce((acc, [re, to]) => acc.replace(re, to), s);

const players = {};
const renamedShort = new Map(); // raw short name -> fixed, for dismissal texts
// The API's own list form, "Hoogdalem, Floris v", becomes "Hoogdalem van, Floris" (jaarverslag style).
// It knows multi-word surnames ("Roscam Abbing") that can't be read from the full name.
function fixListName(name) {
  if (!name || !name.includes(',')) return name ? name.trim() : name;
  let [sur, first] = name.split(',').map(s => s.trim());
  const w = first.split(/\s+/), moved = [];
  while (w.length > 1 && isParticle(w[w.length - 1])) moved.unshift(w.pop());
  const expand = x => PARTICLE[x] || x;
  if (moved.length) sur = `${sur} ${moved.map(expand).join(' ')}`;
  sur = sur.split(' ').map(expand).join(' ');
  if (!isShortCaps(first)) first = w.map(x => (/^[A-Z]{3,}$/.test(x) ? x[0] + x.slice(1).toLowerCase() : x)).join(' ');
  return `${sur}, ${first}`;
}
const isShortCaps = s => /^[A-Z]{1,3}$/.test(s);

const addPlayer = (id, short, full, list) => {
  if (id == null) return;
  const raw = (short || '').trim();
  short = fixName(short, true); full = fixName(full, false); list = fixListName(list);
  if (raw.includes(' ') && short && raw !== short) renamedShort.set(raw, short);
  const p = players[id] || (players[id] = [short || '', full || '', list || '']);
  if (short && !p[0]) p[0] = short;
  if (full && !p[1]) p[1] = full;
  if (list && !p[2]) p[2] = list;
};

const RESULT = { 2: 'W', 1: 'L' };
function resultOf(m, us, them) {
  const t = (m.leader_text || '').toLowerCase();
  if (us.result_flag === 2 || (them && them.result_flag === 1 && us.result_flag !== 1)) return 'W';
  if (us.result_flag === 1) return 'L';
  if (/tie/.test(t)) return 'T';
  if (/abandon|no result|cancel|forfeit|walk ?over/.test(t)) return 'A';
  if (/draw/.test(t)) return 'D';
  if (!(us.Innings || []).length && !(them?.Innings || []).length) return 'N';
  return RESULT[us.result_flag] || 'D';
}

// ---- guest players --------------------------------------------------------------
// A player without a Matchcentre profile gets a match-local id (-101, -102, ...) that other
// matches reuse for other people. Give each guest an id of their own, derived from the name,
// or the registered player's id when the same club has a player with that name.
const nameKey = s => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const PLACEHOLDER = /player|speler|extra|repeat|custom|lastname|unknown|onbekend/i;
const registered = new Map(); // club entity id + name -> player id
const knownIds = new Set();
for (const d of details) {
  for (const t of d?.MatchTeams || []) {
    for (const tm of t.TeamMembers || []) {
      if (!(tm.player_id > 0)) continue;
      knownIds.add(tm.player_id);
      addPlayer(tm.player_id, tm.player_name3, tm.player_name2, tm.player_name);
      const k = `${t.entity_id}|${nameKey(tm.player_name2 || `${tm.f_name} ${tm.l_name}`)}`;
      if (!registered.has(k)) registered.set(k, tm.player_id);
    }
    for (const inn of t.Innings || []) for (const p of inn.PlayerPerfs || []) if (p.player_id > 0) { knownIds.add(p.player_id); addPlayer(p.player_id, p.player_name); }
  }
}
const hashId = s => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return -(1000 + (Math.abs(h) % 1e9)); };

// ---- data issues ------------------------------------------------------------------
// [match id, side 'v'|'o', type, description]; the page groups them by type.
const issues = [];
const HOW_NAME = { 2: 'caught', 3: 'lbw', 4: 'bowled', 5: 'stumped', 7: 'hit wicket' };
const toBalls = o => (o == null ? 0 : Math.trunc(o) * 6 + Math.round((o - Math.trunc(o)) * 10));
const oversOf = b => `${Math.floor(b / 6)}${b % 6 ? '.' + (b % 6) : ''}`;
const NOT_OUT_IDS = new Set([0, 1, 13, 14, 15]);

const matches = [];
wanted.forEach(({ listing, teamId }, i) => {
  const m = details[i] || listing;
  const us = m.MatchTeams.find(t => t.entity_id === CLUB_ENTITY_ID);
  const them = m.MatchTeams.find(t => t !== us);
  if (!them || /^bye$/i.test(them.team_name)) return;
  const sideOf = t => (t === us ? 'v' : 'o');
  const issue = (side, type, text) => issues.push([m.match_id, side, type, text]);
  // Youth pairs cricket (U11 and younger) scores in its own way, so totals aren't checked there.
  const pairs = /\bU ?(9|10|11)\b/i.test(teams.get(teamId).grade);

  const idMap = new Map();
  for (const t of m.MatchTeams) {
    for (const tm of t.TeamMembers || []) {
      if (tm.player_id > 0) { addPlayer(tm.player_id, tm.player_name3, tm.player_name2, tm.player_name); continue; }
      const first = (tm.f_name || tm.adhoc_player_firstname || '').trim(), last = (tm.l_name || tm.adhoc_player_lastname || '').trim();
      const full = `${first} ${last}`.trim();
      const real = first && last && !PLACEHOLDER.test(full) && full.replace(/\s/g, '').length > 2;
      const reg = real && registered.get(`${t.entity_id}|${nameKey(full)}`);
      const id = reg || hashId(real ? `${t.entity_id}|${nameKey(full)}` : `${m.match_id}|${t.entity_id}|${tm.player_id}`);
      idMap.set(`${t.entity_id}|${tm.player_id}`, id);
      if (reg) {
        issue(sideOf(t), 'guest-registered', `${full} (${t.team_name}) is entered as a guest player, but has a Matchcentre profile. Counted as that player here.`);
      } else {
        addPlayer(id, tm.player_name3 || full, tm.player_name2 || full, tm.player_name);
        issue(sideOf(t), real ? 'guest' : 'guest-noname', real
          ? `${full} (${t.team_name}) has no Matchcentre profile.`
          : `${t.team_name} has a player entered as "${(tm.player_name || '').trim() || '?'}", without a real name.`);
      }
    }
  }
  const pidOf = (t, id) => (id == null || id === 0 ? null : id > 0 ? id : idMap.get(`${t.entity_id}|${id}`) ?? hashId(`${m.match_id}|${t.entity_id}|${id}`));

  const innings = [];
  for (const side of [us, them]) {
    const field = side === us ? them : us;
    const fieldIds = new Set((field.TeamMembers || []).map(tm => pidOf(field, tm.player_id)));
    const who = side === us ? teams.get(teamId).label : side.team_name;
    for (const inn of side.Innings || []) {
      const perfs = inn.PlayerPerfs || [];
      const of = type => perfs.filter(p => p.__type.startsWith(type));
      for (const p of perfs) {
        const t = p.__type.startsWith('Batting') ? side : field;
        if (p.player_id > 0) addPlayer(p.player_id, p.player_name);
        else if (!idMap.has(`${t.entity_id}|${p.player_id}`)) addPlayer(pidOf(t, p.player_id), p.player_name, p.player_name);
      }
      const bowlers = of('Bowling');
      bowlers.forEach(b => fieldIds.add(pidOf(field, b.player_id)));
      const batted = of('Batting').filter(b => b.dismissal_id !== 0 || b.runs != null);
      const s = sideOf(side), fs = sideOf(field);
      const shortName = (t, id) => players[pidOf(t, id)]?.[0] || 'Unknown';

      // A dismissal credited to someone outside the fielding side's team list: keep it when the
      // player is known from other matches, drop it when nobody knows who it is.
      const fielderOf = (b, id, role) => {
        const pid = pidOf(field, id);
        if (!pid) return null;
        if (!fieldIds.size || fieldIds.has(pid)) return pid;
        if (pid > 0 && knownIds.has(pid)) {
          issue(fs, 'not-in-lineup', `${shortName(field, id)} is credited as ${role} (${b.player_name}: ${b.dismissal_text.trim()}), but isn't in ${field.team_name}'s team list. Probably the wrong player was picked.`);
          return pid;
        }
        return undefined; // unknown player
      };
      const bat = batted.map(b => {
        const text = (b.dismissal_text || '').trim();
        let fielder = b.dismisser1_id, bowler = b.dismisser2_id;
        if (b.dismissal_id === 2 || b.dismissal_id === 5) {
          const role = b.dismissal_id === 2 ? 'catcher' : 'wicketkeeper';
          fielder = fielderOf(b, fielder, role);
          if (!fielder) issue(fs, b.dismissal_id === 2 ? 'no-catcher' : 'no-keeper', `${b.player_name} (${who}) ${HOW_NAME[b.dismissal_id]} "${text}", ${fielder === undefined ? `${role} is a player id without a name` : `${role} not recorded`}.`);
          else if (/\?|^(c|st)\s*(b\b|$)/.test(text) && !/^c\s*&\s*b/.test(text)) issue(fs, b.dismissal_id === 2 ? 'no-catcher' : 'no-keeper', `${b.player_name} (${who}) "${text}": the scorecard text has no ${role}.`);
          fielder = fielder || null;
        } else if (b.dismissal_id === 6) {
          fielder = fielderOf(b, fielder, 'run-out fielder') || null;
          if (!fielder) issue(fs, 'no-runout-fielder', `${b.player_name} (${who}) run out, fielder not recorded.`);
          bowler = bowler ? (fielderOf(b, bowler, 'run-out fielder') || null) : null;
        } else {
          fielder = fielder ? pidOf(field, fielder) : null;
        }
        if (HOW_NAME[b.dismissal_id] && b.dismissal_id !== 6) {
          const bw = bowler ? fielderOf(b, bowler, 'bowler') : null;
          if (!bw) issue(fs, 'no-bowler', `${b.player_name} (${who}) ${HOW_NAME[b.dismissal_id]} "${text}", bowler ${bw === undefined ? 'is a player id without a name' : 'not recorded'}.`);
          bowler = bw || null;
        }
        if (!NOT_OUT_IDS.has(b.dismissal_id) && b.fow == null) issue(s, 'no-fow', `${b.player_name} (${who}) is out "${text}", but has no fall-of-wicket score.`);
        if (b.dismissal_id !== 15 && b.balls == null && b.runs != null) issue(s, 'no-balls', `${b.player_name} (${who}) scored ${b.runs}, balls faced not recorded.`);
        return [pidOf(side, b.player_id), b.number, b.runs, b.balls, b.fours, b.sixes, b.dismissal_id, b.dismissal_text, b.fow, b.fow_order, fielder, bowler];
      });

      if (inn.runs != null) {
        const total = `${who} ${inn.runs}/${inn.wickets ?? '?'}`;
        if (!batted.length) issue(s, 'no-card', `${total}: no batting card.`);
        if (!bowlers.length) issue(fs, 'no-card', `${total}: no bowling card.`);
        if (!pairs && batted.length) {
          const runs = batted.reduce((a, b) => a + (b.runs || 0), 0);
          if (runs + (inn.extras || 0) !== inn.runs) issue(s, 'bat-sum', `${total}: batters' runs (${runs}) + extras (${inn.extras || 0}) = ${runs + (inn.extras || 0)}, not ${inn.runs}.`);
          const outs = batted.filter(b => !NOT_OUT_IDS.has(b.dismissal_id)).length;
          if (inn.wickets != null && outs !== inn.wickets) issue(s, 'wkts', `${total}: ${outs} batters are out, but the total says ${inn.wickets} wickets.`);
        }
        if (!pairs && bowlers.length) {
          const runs = bowlers.reduce((a, b) => a + (b.runs || 0), 0);
          const byes = (inn.byes || 0) + (inn.leg_byes || 0) + (inn.penalty_runs || 0);
          if (runs + byes !== inn.runs) issue(fs, 'bowl-sum', `${total}: bowlers' runs (${runs}) + byes, leg byes and penalties (${byes}) = ${runs + byes}, not ${inn.runs}.`);
          const balls = bowlers.reduce((a, b) => a + toBalls(b.overs), 0);
          if (inn.overs_bowled != null && balls !== toBalls(inn.overs_bowled)) issue(fs, 'bowl-overs', `${total}: bowlers' overs add up to ${oversOf(balls)}, the innings lasted ${oversOf(toBalls(inn.overs_bowled))} overs.`);
          const wk = bowlers.reduce((a, b) => a + (b.wickets || 0), 0);
          const byBowler = batted.filter(b => HOW_NAME[b.dismissal_id]).length;
          if (wk !== byBowler) issue(fs, 'bowl-wkts', `${total}: bowlers have ${wk} wickets, but ${byBowler} batters were out bowled, caught, lbw, stumped or hit wicket.`);
        }
      }

      innings.push({
        side: s, no: inn.innings_number, order: inn.innings_order,
        runs: inn.runs, wkts: inn.wickets, overs: inn.overs_bowled, closed: inn.close_type_id,
        x: [inn.extras, inn.byes, inn.leg_byes, inn.wides, inn.no_balls, inn.penalty_runs],
        bat,
        dnb: of('Batting').filter(b => b.dismissal_id === 0 && b.runs == null).map(b => pidOf(side, b.player_id)),
        bowl: bowlers.map(b => [pidOf(field, b.player_id), b.number, b.overs, b.maidens, b.runs, b.wickets, b.wides, b.no_balls]),
        field: of('Fielding').map(f => [pidOf(field, f.player_id), f.catches || 0, f.catches_wk || 0, f.stumpings || 0, f.run_outs_a || 0, f.run_outs_u || 0]),
      });
    }
  }
  innings.sort((a, b) => (a.order ?? 9) - (b.order ?? 9));
  const leader = m.leader_text || '';
  matches.push({
    id: m.match_id, team: teamId, date: msDate(m.date1), round: m.round, opp: them.team_name, oppClub: them.club_name,
    home: !!us.is_home, venue: m.venue_name || '', status: m.status_id, result: resultOf(m, us, them),
    leader, score: m.score_text || '', toss: m.toss_won_by === us.team_name ? 'v' : (m.toss_won_by ? 'o' : null),
    maxOvers: m.MatchConfig?.max_overs ?? null, innings, detail: !!details[i],
  });
});
matches.sort((a, b) => a.date - b.date);

const out = {
  season: SEASON_YEAR, generated: new Date().toISOString(), club: 'VCC', refreshed: REFRESH,
  teams: [...teams.values()].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label)),
  matches, players, issues: issues.map(x => [x[0], x[1], x[2], fixDismissal(rename(x[3]))]),
};
await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
const file = path.join(ROOT, 'data', `season-${SEASON_YEAR}.json`);
for (const m of out.matches) {
  for (const k of ['opp', 'oppClub', 'leader', 'score', 'venue']) m[k] = rename(m[k] || '');
  for (const inn of m.innings) for (const b of inn.bat) b[7] = fixDismissal(rename(b[7] || ''));
}
function fixDismissal(text) {
  // Longest names first, so "BJA Leede de" wins over a shorter overlap.
  for (const [raw, fixed] of [...renamedShort].sort((a, b) => b[0].length - a[0].length)) {
    text = text.split(raw).join(fixed);
  }
  return text;
}

// ---- what changed since the previous run ---------------------------------------------
let prev = null;
try { prev = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
const entry = prev ? describeChanges(prev, out) : null;
out.previous = prev?.generated || null; // the fetch this one was compared with
out.changes = (prev?.changes || []).slice(0, 24);
if (entry && (entry.matches.length || entry.players.length || entry.teams.length)) out.changes.unshift(entry);

function describeChanges(old, cur) {
  const nameIn = (d, pid) => d.players[pid]?.[0] || 'Unknown';
  const played = m => m.innings.some(i => i.runs != null);
  const teamLbl = id => cur.teams.find(t => t.id === id)?.label || id;
  const batLine = b => `${b[2] ?? '–'}${b[3] != null ? ` (${b[3]})` : ''}${b[7] ? `, ${b[7].trim()}` : ''}`;
  const bowlLine = w => `${w[2] ?? 0}-${w[3] ?? 0}-${w[4] ?? 0}-${w[5] ?? 0}`;
  const total = i => (i.runs == null ? '–' : `${i.runs}/${i.wkts ?? 0}${i.overs != null ? ` (${i.overs} ov)` : ''}`);
  // Card rows pair up by player; what's left (guests, whose ids aren't stable) by position on the card.
  const pairRows = (then, now) => {
    const left = [...then], pairs = [];
    const take = i => left.splice(i, 1)[0];
    const rest = [];
    for (const b of now) {
      const i = left.findIndex(x => x[0] === b[0] && b[0] > 0);
      if (i >= 0) pairs.push([take(i), b]); else rest.push(b);
    }
    for (const b of rest) {
      const i = left.findIndex(x => x[1] === b[1] && (x[0] <= 0 || b[0] <= 0));
      pairs.push([i >= 0 ? take(i) : null, b]);
    }
    return pairs.concat(left.map(x => [x, null]));
  };
  const oldById = new Map(old.matches.map(m => [m.id, m]));
  const items = [];
  for (const m of cur.matches) {
    const o = oldById.get(m.id);
    oldById.delete(m.id);
    if (!o) { items.push({ id: m.id, kind: played(m) ? 'new' : 'fixture', lines: played(m) ? [m.leader || m.score] : [] }); continue; }
    if (!played(o) && played(m)) { items.push({ id: m.id, kind: 'new', lines: [m.leader || m.score] }); continue; }
    const lines = [];
    const ch = (label, a, b) => { if (String(a ?? '') !== String(b ?? '')) lines.push(`${label}: ${a || '–'} → ${b || '–'}`); };
    ch('Result', o.leader, m.leader);
    ch('Score', o.score, m.score);
    if (o.date !== m.date) ch('Date', new Date(o.date).toISOString().slice(0, 10), new Date(m.date).toISOString().slice(0, 10));
    for (const inn of m.innings) {
      const oi = o.innings.find(x => x.side === inn.side && x.no === inn.no);
      const who = inn.side === 'v' ? teamLbl(m.team) : m.opp;
      if (!oi) { lines.push(`${who} innings added: ${total(inn)}`); continue; }
      ch(`${who} total`, total(oi), total(inn));
      ch(`${who} extras`, oi.x[0], inn.x[0]);
      for (const [card, rowsNow, rowsThen, line] of [['batting', inn.bat, oi.bat, batLine], ['bowling', inn.bowl, oi.bowl, bowlLine]]) {
        for (const [x, b] of pairRows(rowsThen, rowsNow)) {
          if (!x) lines.push(`${nameIn(cur, b[0])} added to the ${card} card: ${line(b)}`);
          else if (!b) lines.push(`${nameIn(old, x[0])} removed from the ${card} card`);
          else {
            const nm = nameIn(cur, b[0]);
            if (x[0] !== b[0] && x[0] > 0 && b[0] > 0) lines.push(`${card === 'batting' ? 'Batter' : 'Bowler'} ${nameIn(old, x[0])} replaced by ${nm}`);
            ch(`${nm} ${card}`, line(x), line(b));
          }
        }
      }
    }
    for (const oi of o.innings) {
      if (!m.innings.some(x => x.side === oi.side && x.no === oi.no)) lines.push(`${oi.side === 'v' ? teamLbl(m.team) : m.opp} innings removed`);
    }
    if (lines.length) items.push({ id: m.id, kind: 'changed', lines });
  }
  for (const o of oldById.values()) items.push({ id: o.id, kind: 'removed', lines: [`${teamLbl(o.team)} v ${o.opp}, ${new Date(o.date).toISOString().slice(0, 10)}`] });
  const renamed = Object.keys(cur.players).filter(pid => +pid > 0 && old.players[pid] && old.players[pid][1] && old.players[pid][1] !== cur.players[pid][1])
    .map(pid => [+pid, old.players[pid][1], cur.players[pid][1]]);
  const newTeams = cur.teams.filter(t => !old.teams.some(x => x.id === t.id)).map(t => `${t.label} (${t.grade})`);
  return { at: cur.generated, since: old.generated, refresh: REFRESH, matches: items, players: renamed, teams: newTeams };
}

await fs.writeFile(file, JSON.stringify(out));
const played = matches.filter(m => m.innings.length).length;
console.log(`Wrote ${path.relative(ROOT, file)}: ${matches.length} matches (${played} with scores), ${Object.keys(players).length} players, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
const byType = issues.reduce((a, x) => ((a[x[2]] = (a[x[2]] || 0) + 1), a), {});
console.log(`Data issues: ${issues.length}`, byType);
if (entry) console.log(`Changes since ${entry.since}: ${entry.matches.length} matches, ${entry.players.length} renamed players, ${entry.teams.length} new teams`);
