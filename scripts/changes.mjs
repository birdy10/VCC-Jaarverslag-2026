// What changed between two data files: new and removed matches, changed scorecards, players swapped
// on a card (a guest linked to their profile counts too) and Matchcentre issues fixed or added.
// Used by fetch-data.mjs after every run; backfill-changes.mjs replays it on older data files.

export function describeChanges(old, cur, refresh) {
  const nameIn = (d, pid) => d.players[pid]?.[1] || d.players[pid]?.[0] || 'Unknown';
  const played = m => m.innings.some(i => i.runs != null);
  const teamLbl = id => cur.teams.find(t => t.id === id)?.label || id;
  const batLine = b => `${b[2] ?? '–'}${b[3] != null ? ` (${b[3]})` : ''}${b[7] ? `, ${b[7].trim()}` : ''}`;
  const bowlLine = w => `${w[2] ?? 0}-${w[3] ?? 0}-${w[4] ?? 0}-${w[5] ?? 0}`;
  const total = i => (i.runs == null ? '–' : `${i.runs}/${i.wkts ?? 0}${i.overs != null ? ` (${i.overs} ov)` : ''}`);
  // Issues per match, as text, to see which were fixed and which are new.
  const issuesOf = d => (d.issues || []).reduce((a, [id, , , text]) => ((a[id] = a[id] || new Set()).add(text), a), {});
  const issOld = issuesOf(old), issCur = issuesOf(cur);
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
            const was = nameIn(old, x[0]);
            if (x[0] !== b[0]) lines.push(was === nm && b[0] > 0 ? `${nm} (${card}) linked to their Matchcentre profile` : `${card === 'batting' ? 'Batter' : 'Bowler'} ${was} replaced by ${nm}`);
            ch(`${nm} ${card}`, line(x), line(b));
          }
        }
      }
    }
    for (const oi of o.innings) {
      if (!m.innings.some(x => x.side === oi.side && x.no === oi.no)) lines.push(`${oi.side === 'v' ? teamLbl(m.team) : m.opp} innings removed`);
    }
    const was = issOld[m.id] || new Set(), now = issCur[m.id] || new Set();
    const first = t => t.replace(/\. .*$/, '.'); // the issue itself, not the "counted as" aside
    const fixed = [...was].filter(t => !now.has(t)).map(t => `Fixed: ${first(t)}`);
    const added = [...now].filter(t => !was.has(t)).map(t => `New issue: ${first(t)}`);
    // Only fixes (a guest linked to a profile changes no figures): its own kind, so it stands out in the log.
    const kind = fixed.length && !added.length && lines.every(l => / replaced by | linked to their /.test(l)) ? 'fixed' : 'changed';
    lines.push(...fixed, ...added);
    if (lines.length) items.push({ id: m.id, kind, lines });
  }
  for (const o of oldById.values()) items.push({ id: o.id, kind: 'removed', lines: [`${teamLbl(o.team)} v ${o.opp}, ${new Date(o.date).toISOString().slice(0, 10)}`] });
  const renamed = Object.keys(cur.players).filter(pid => +pid > 0 && old.players[pid] && old.players[pid][1] && old.players[pid][1] !== cur.players[pid][1])
    .map(pid => [+pid, old.players[pid][1], cur.players[pid][1]]);
  const newTeams = cur.teams.filter(t => !old.teams.some(x => x.id === t.id)).map(t => `${t.label} (${t.grade})`);
  return { at: cur.generated, since: old.generated, refresh, matches: items, players: renamed, teams: newTeams };
}
