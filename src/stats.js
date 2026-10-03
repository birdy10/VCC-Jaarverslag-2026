// Stats engine: turns the season dataset into flat performance rows and
// derives leaderboards, milestones and records for any filtered set of matches.
// Runs in the browser (window.VCCStats) and in Node (module.exports) for testing.
(function (root) {
  'use strict';

  // Dismission ids from ResultVault
  const NOT_OUT = new Set([1, 14]);          // not out, retired not out
  const RETIRED = new Set([13, 14]);         // retired (hurt/out), retired not out
  const ABSENT = 15;
  const HOW = { 1: 'Not out', 2: 'Caught', 3: 'LBW', 4: 'Bowled', 5: 'Stumped', 6: 'Run out', 7: 'Hit wicket', 13: 'Retired', 14: 'Retired not out', 15: 'Absent' };

  const toBalls = overs => {
    if (overs == null) return 0;
    const whole = Math.trunc(overs);
    return whole * 6 + Math.round((overs - whole) * 10);
  };
  const toOvers = balls => `${Math.floor(balls / 6)}${balls % 6 ? '.' + (balls % 6) : ''}`;
  const div = (a, b) => (b ? a / b : null);

  // ---- partnerships from fall-of-wicket data ---------------------------------
  // Batters walk in by batting position; each wicket (ordered by fow, fow_order)
  // ends a stand. A retired batter leaves at an unknown score, so any stand that
  // involves one is marked approximate.
  function partnerships(inn, bats) {
    const order = bats.filter(b => b.how !== ABSENT).sort((a, b) => a.pos - b.pos);
    if (order.length < 2) return [];
    const unknownExit = b => RETIRED.has(b.did) && b.fow == null;
    const wickets = order.filter(b => !NOT_OUT.has(b.did) && b.did !== 13 && b.fow != null)
      .sort((a, b) => a.fow - b.fow || (a.fowOrder || 0) - (b.fowOrder || 0));
    const crease = [order[0], order[1]];
    const queue = order.slice(2);
    const out = [];
    let prev = 0, wkt = 0;
    const bringIn = (leaving, arriving) => {
      crease[crease.indexOf(leaving)] = arriving;
      queue.splice(queue.indexOf(arriving), 1);
    };
    for (const w of wickets) {
      let approx = crease.some(unknownExit);
      if (!crease.includes(w)) {
        // Someone left without a wicket (retired) or the batting order is off.
        approx = true;
        const leaving = crease.find(unknownExit) || crease.find(c => c.pos === Math.max(...crease.map(x => x.pos)));
        if (queue.includes(w)) bringIn(leaving, w); else crease[crease.indexOf(leaving)] = w;
      }
      wkt++;
      out.push({ wkt, runs: w.fow - prev, a: crease[0].pid, b: crease[1].pid, approx, unbroken: false });
      prev = w.fow;
      const next = queue.find(q => !unknownExit(q) || true);
      if (next) bringIn(w, next); else crease[crease.indexOf(w)] = null;
      if (crease.includes(null)) break;
    }
    if (!crease.includes(null) && inn.runs - prev > 0) {
      let approx = crease.some(unknownExit);
      // Make sure the stand at the end is between the batters who finished not out.
      for (const c of [...crease]) {
        if (unknownExit(c)) {
          const stayer = queue.find(q => NOT_OUT.has(q.did) && !RETIRED.has(q.did));
          if (stayer) { bringIn(c, stayer); approx = true; }
        }
      }
      out.push({ wkt: wkt + 1, runs: inn.runs - prev, a: crease[0].pid, b: crease[1].pid, approx, unbroken: true });
    }
    return out;
  }

  // ---- prepare: flatten everything once --------------------------------------
  function prepare(data) {
    const teams = new Map(data.teams.map(t => [t.id, t]));
    const name = pid => (data.players[pid] && data.players[pid][0]) || 'Unknown';
    const fullName = pid => (data.players[pid] && (data.players[pid][1] || data.players[pid][0])) || 'Unknown';
    const rows = { bat: [], bowl: [], field: [], pship: [], team: [], apps: [] };

    for (const m of data.matches) {
      m.teamObj = teams.get(m.team);
      m.played = m.innings.some(i => i.runs != null);
      const margin = /won by (\d+) (run|wicket)/i.exec(m.leader || '');
      m.marginRuns = margin && /run/i.test(margin[2]) ? +margin[1] : null;
      m.marginWkts = margin && /wicket/i.test(margin[2]) ? +margin[1] : null;
      m.dls = /DLS|D\/L/i.test(m.leader || '');
      const first = m.innings.find(i => i.order === 1) || m.innings[0];
      m.battedFirst = first ? first.side : null;
      m.month = m.date ? new Date(m.date).getMonth() : null;
      m.ourRuns = m.innings.filter(i => i.side === 'v').reduce((s, i) => s + (i.runs || 0), 0);
      m.theirRuns = m.innings.filter(i => i.side === 'o').reduce((s, i) => s + (i.runs || 0), 0);

      const appeared = { v: new Set(), o: new Set() };
      for (const inn of m.innings) {
        const batSide = inn.side, fieldSide = inn.side === 'v' ? 'o' : 'v';
        const bats = inn.bat.map(b => ({
          m, inn, side: batSide, pid: b[0], pos: b[1], runs: b[2] || 0, balls: b[3], fours: b[4] || 0, sixes: b[5] || 0,
          did: b[6], text: b[7], fow: b[8], fowOrder: b[9], fielder: b[10], bowler: b[11],
        }));
        for (const b of bats) {
          b.how = b.did;
          b.out = !NOT_OUT.has(b.did) && b.did !== ABSENT && b.did !== 13;
          b.inns = b.did !== ABSENT;
          b.duck = b.out && b.runs === 0;
          b.sr = b.balls ? (b.runs / b.balls) * 100 : null;
          appeared[batSide].add(b.pid);
          if (b.inns) rows.bat.push(b);
        }
        inn.dnb.forEach(p => appeared[batSide].add(p));
        // team top scorer flag
        const top = Math.max(0, ...bats.map(b => b.runs));
        bats.forEach(b => { b.topScore = top > 0 && b.runs === top; });

        for (const w of inn.bowl) {
          const balls = toBalls(w[2]);
          rows.bowl.push({ m, inn, side: fieldSide, pid: w[0], num: w[1], overs: w[2], balls, maidens: w[3] || 0, runs: w[4] || 0, wkts: w[5] || 0, wides: w[6] || 0, nb: w[7] || 0, econ: balls ? (w[4] || 0) / (balls / 6) : null });
          appeared[fieldSide].add(w[0]);
        }
        // Fielding comes from the dismissals: the Fielding records in the API miss some catches.
        for (const b of bats) {
          const credit = (pid, key) => {
            if (!pid) return;
            rows.field.push({ m, inn, side: fieldSide, pid, ct: key === 'ct' ? 1 : 0, st: key === 'st' ? 1 : 0, ro: key === 'ro' ? 1 : 0, victim: b });
            appeared[fieldSide].add(pid);
          };
          if (b.did === 2) credit(b.fielder, 'ct');
          else if (b.did === 5) credit(b.fielder, 'st');
          else if (b.did === 6) { credit(b.fielder, 'ro'); if (b.bowler && b.bowler !== b.fielder) credit(b.bowler, 'ro'); }
        }
        inn.field.forEach(f => appeared[fieldSide].add(f[0]));
        for (const p of partnerships(inn, bats)) rows.pship.push({ m, inn, side: batSide, ...p });

        const chased = inn.order === 2;
        const won = (batSide === 'v' && m.result === 'W') || (batSide === 'o' && m.result === 'L');
        rows.team.push({
          m, inn, side: batSide, runs: inn.runs || 0, wkts: inn.wkts || 0, overs: inn.overs, balls: toBalls(inn.overs),
          extras: inn.x[0] || 0, byes: inn.x[1] || 0, lb: inn.x[2] || 0, wides: inn.x[3] || 0, nb: inn.x[4] || 0,
          allOut: (inn.wkts || 0) >= 10, chased, won,
          // A successful chase stops early, so it doesn't count as a low total.
          completed: !(chased && won),
        });
      }
      for (const side of ['v', 'o']) for (const pid of appeared[side]) rows.apps.push({ m, side, pid });
    }
    // Ducks first ball
    rows.bat.forEach(b => { b.golden = b.duck && b.balls === 1; });
    return { data, teams, rows, name, fullName, matches: data.matches };
  }

  // ---- filtering -------------------------------------------------------------
  // f = { teams:Set|null, result:'all'|'W'|'L'|'other', venue:'all'|'home'|'away', toss:'all'|'first'|'chase',
  //       months:Set|null, opponents:Set|null, side:'v'|'o'|'both', player:pid|null }
  function matchFilter(f) {
    return m => {
      if (!m.played) return false;
      if (f.teams && f.teams.size && !f.teams.has(m.team)) return false;
      if (f.result === 'W' && m.result !== 'W') return false;
      if (f.result === 'L' && m.result !== 'L') return false;
      if (f.result === 'other' && (m.result === 'W' || m.result === 'L')) return false;
      if (f.venue === 'home' && !m.home) return false;
      if (f.venue === 'away' && m.home) return false;
      if (f.toss === 'first' && m.battedFirst !== 'v') return false;
      if (f.toss === 'chase' && m.battedFirst !== 'o') return false;
      if (f.months && f.months.size && !f.months.has(m.month)) return false;
      if (f.opponents && f.opponents.size && !f.opponents.has(m.oppClub)) return false;
      return true;
    };
  }

  function apply(S, f) {
    const keepMatch = matchFilter(f);
    const ms = S.matches.filter(keepMatch);
    const set = new Set(ms);
    const sideOk = r => f.side === 'both' || r.side === f.side;
    const playerOk = r => !f.player || r.pid === f.player || r.a === f.player || r.b === f.player;
    const pick = arr => arr.filter(r => set.has(r.m) && sideOk(r) && playerOk(r));
    if (f.player) {
      // A player filter narrows the matches to the ones that player played in.
      const theirs = new Set(S.rows.apps.filter(a => a.pid === f.player && set.has(a.m)).map(a => a.m));
      for (const m of [...set]) if (!theirs.has(m)) set.delete(m);
    }
    return {
      matches: ms.filter(m => set.has(m)),
      bat: pick(S.rows.bat), bowl: pick(S.rows.bowl), field: pick(S.rows.field), pship: pick(S.rows.pship),
      team: S.rows.team.filter(r => set.has(r.m) && sideOk(r)),
      teamAll: S.rows.team.filter(r => set.has(r.m)),
      apps: pick(S.rows.apps),
    };
  }

  // ---- aggregates ------------------------------------------------------------
  const groupBy = (arr, key) => {
    const g = new Map();
    for (const r of arr) { const k = key(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    return g;
  };

  function batting(rows, apps) {
    const mCount = apps ? groupBy(apps, a => a.pid) : new Map();
    return [...groupBy(rows, r => r.pid)].map(([pid, rs]) => {
      const runs = rs.reduce((s, r) => s + r.runs, 0);
      const balls = rs.reduce((s, r) => s + (r.balls || 0), 0);
      const outs = rs.filter(r => r.out).length;
      const best = rs.reduce((a, r) => (r.runs > a.runs || (r.runs === a.runs && !r.out && a.out) ? r : a));
      return {
        pid, side: rs[0].side, mat: (mCount.get(pid) || []).length || new Set(rs.map(r => r.m)).size,
        inns: rs.length, no: rs.length - outs, runs, balls, hs: best.runs, hsNo: !best.out, hsRow: best,
        avg: div(runs, outs), sr: balls ? (runs / balls) * 100 : null,
        fifties: rs.filter(r => r.runs >= 50 && r.runs < 100).length, hundreds: rs.filter(r => r.runs >= 100).length,
        fours: rs.reduce((s, r) => s + r.fours, 0), sixes: rs.reduce((s, r) => s + r.sixes, 0),
        ducks: rs.filter(r => r.duck).length, tops: rs.filter(r => r.topScore).length,
      };
    });
  }

  function bowling(rows) {
    return [...groupBy(rows, r => r.pid)].map(([pid, rs]) => {
      const balls = rs.reduce((s, r) => s + r.balls, 0);
      const runs = rs.reduce((s, r) => s + r.runs, 0);
      const wkts = rs.reduce((s, r) => s + r.wkts, 0);
      const best = rs.reduce((a, r) => (r.wkts > a.wkts || (r.wkts === a.wkts && r.runs < a.runs) ? r : a));
      return {
        pid, side: rs[0].side, spells: rs.length, balls, overs: toOvers(balls), maidens: rs.reduce((s, r) => s + r.maidens, 0),
        runs, wkts, best: `${best.wkts}-${best.runs}`, bestRow: best, avg: div(runs, wkts), econ: balls ? runs / (balls / 6) : null,
        sr: div(balls, wkts), fourW: rs.filter(r => r.wkts >= 4).length, fiveW: rs.filter(r => r.wkts >= 5).length,
        wides: rs.reduce((s, r) => s + r.wides, 0), nb: rs.reduce((s, r) => s + r.nb, 0),
      };
    });
  }

  function fielding(rows) {
    return [...groupBy(rows, r => r.pid)].map(([pid, rs]) => {
      const ct = rs.reduce((s, r) => s + r.ct, 0), st = rs.reduce((s, r) => s + r.st, 0), ro = rs.reduce((s, r) => s + r.ro, 0);
      return { pid, side: rs[0].side, ct, st, ro, tot: ct + st + ro };
    });
  }

  // Fielding per player per match (a match can have two innings).
  function fieldingByMatch(rows) {
    return [...groupBy(rows, r => r.m.id + ':' + r.pid)].map(([, rs]) => {
      const ct = rs.reduce((s, r) => s + r.ct, 0), st = rs.reduce((s, r) => s + r.st, 0), ro = rs.reduce((s, r) => s + r.ro, 0);
      return { m: rs[0].m, side: rs[0].side, pid: rs[0].pid, ct, st, ro, tot: ct + st + ro };
    });
  }

  function summary(r) {
    const ours = r.teamAll.filter(t => t.side === 'v');
    const theirs = r.teamAll.filter(t => t.side === 'o');
    const res = k => r.matches.filter(m => m.result === k).length;
    const completed = ours.filter(t => t.completed);
    const hi = ours.reduce((a, t) => (!a || t.runs > a.runs ? t : a), null);
    const lo = completed.reduce((a, t) => (!a || t.runs < a.runs ? t : a), null);
    return {
      played: r.matches.length, won: res('W'), lost: res('L'), other: r.matches.length - res('W') - res('L'),
      form: r.matches.map(m => m.result),
      runs: ours.reduce((s, t) => s + t.runs, 0),
      wkts: theirs.reduce((s, t) => s + t.wkts, 0),
      runsAgainst: theirs.reduce((s, t) => s + t.runs, 0),
      extrasFor: ours.reduce((s, t) => s + t.extras, 0),
      extrasAgainst: theirs.reduce((s, t) => s + t.extras, 0),
      highest: hi, lowest: lo,
    };
  }

  root.VCCStats = {
    prepare, apply, matchFilter, batting, bowling, fielding, fieldingByMatch, summary, partnerships,
    toBalls, toOvers, HOW, NOT_OUT,
  };
  if (typeof module !== 'undefined') module.exports = root.VCCStats;
})(typeof window !== 'undefined' ? window : globalThis);
