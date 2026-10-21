// Lets anyone on the season page reload all data ("Refresh data" workflow, every scorecard downloaded again),
// without a GitHub account, and keeps the fixes captains save with "Fix it" in a Google Sheet for the admins.
// Runs as a Google Apps Script web app (Execute as: me, Who has access: Anyone).
// Script properties:
//   GITHUB_TOKEN  a fine-grained GitHub token for this repository only, with "Actions: Read and write"
//   ADMIN_KEY     the key admins type on the page to mark fixes as changed in ResultsVault or reject them
//   FIXES_SHEET   set by the script: the id of the Sheet it made for the fixes on the first save
//
//   GET  ?action=status                     -> { busy, run, cooldownMin, leftToday }
//   GET  ?action=fixes&season=2026[&key=]   -> { fixes: [...], admin, sheet (admins only) }
//   POST {"action":"saveFix", ...}          -> { fix }   one fix per issue: saving again replaces it
//   POST {"action":"setStatus", key, status, note, adminKey} -> { fix }
//   POST (anything else)                    -> { state: started | running | cooldown | limit | error, ... }
//
// One fetch at a time: a script lock makes simultaneous presses see the same run instead of starting two.
// The page posts as text/plain, so browsers send it without a CORS preflight (which Apps Script can't answer).

const REPO = 'birdy10/VCC-Jaarverslag-2026';
const WORKFLOW = 'refresh.yml';
const COOLDOWN_MIN = 10; // no new fetch within 10 minutes of the start of the previous one
const DAILY_MAX = 30;    // fetches started from the page per day (Amsterdam time)

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'fixes') return respond_(() => listFixes_(p.season, p.key));
  return respond_(() => status_());
}

function doPost(e) {
  let req = null;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || ''); } catch (err) {}
  if (req && req.action === 'saveFix') return respond_(() => saveFix_(req));
  if (req && req.action === 'setStatus') return respond_(() => setStatus_(req));
  return respond_(() => refresh_());
}

function respond_(fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    out = { state: 'error', message: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function refresh_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { state: 'running', ...status_() };
  try {
    CacheService.getScriptCache().remove('run');
    const s = status_();
    if (s.busy) return { state: 'running', ...s };
    if (s.cooldownMin > 0) return { state: 'cooldown', ...s };
    if (s.leftToday <= 0) return { state: 'limit', ...s };

    // Download every scorecard again, so fixes made in the Resultsvault/Matchcentre come through too.
    gh_('post', `/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs: { refresh: 'true' } });
    const props = PropertiesService.getScriptProperties();
    props.setProperties({ lastDispatch: String(Date.now()), day: today_(), count: String(DAILY_MAX - s.leftToday + 1) });
    CacheService.getScriptCache().remove('run');
    return { state: 'started', ...status_() };
  } finally {
    lock.releaseLock();
  }
}

function status_() {
  const props = PropertiesService.getScriptProperties();
  const lastDispatch = Number(props.getProperty('lastDispatch') || 0);
  const count = props.getProperty('day') === today_() ? Number(props.getProperty('count') || 0) : 0;
  const run = latestRun_();
  const created = run ? Date.parse(run.created) : 0;
  // A dispatched run takes a few seconds to show up in the API: until then, count it as busy.
  const notVisibleYet = Date.now() - lastDispatch < 90 * 1000 && created < lastDispatch - 5000;
  const lastStart = Math.max(lastDispatch, created);
  return {
    busy: notVisibleYet || (run !== null && run.status !== 'completed'),
    run,
    cooldownMin: Math.max(0, Math.ceil((lastStart + COOLDOWN_MIN * 60000 - Date.now()) / 60000)),
    leftToday: Math.max(0, DAILY_MAX - count),
  };
}

// The latest run that fetched data (pushes only rebuild the page). Cached for a few seconds,
// so many visitors polling at once make few GitHub calls.
function latestRun_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('run');
  if (hit) return JSON.parse(hit);
  const res = gh_('get', `/actions/workflows/${WORKFLOW}/runs?per_page=10`);
  const w = res.workflow_runs.find(r => r.event !== 'push');
  const run = w ? { status: w.status, conclusion: w.conclusion, created: w.created_at, updated: w.updated_at } : null;
  cache.put('run', JSON.stringify(run), 5);
  return run;
}

function gh_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('GITHUB_TOKEN is not set in the script properties.');
  const opts = {
    method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  };
  if (body) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body);
  }
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}${path}`, opts);
  const code = res.getResponseCode();
  if (code >= 300) throw new Error(`GitHub answered ${code}: ${res.getContentText().slice(0, 200)}`);
  return code === 204 ? null : JSON.parse(res.getContentText());
}

// ---- captains' fixes ----------------------------------------------------------------
// One row per issue (key = match id|type|issue text). Admins can read and edit the Sheet directly; the
// page reads it back through listFixes_.
const FIX_COLS = ['key', 'season', 'saved', 'updated', 'captain', 'matchId', 'date', 'team', 'opponent', 'round', 'grade',
  'side', 'type', 'issue', 'fix', 'steps', 'edits', 'status', 'note'];
const FIX_STATUSES = ['saved', 'done-rv', 'rejected'];
const FIX_DAILY_MAX = 500; // saves per day, against a runaway script

function fixSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FIXES_SHEET');
  if (id) return SpreadsheetApp.openById(id).getSheets()[0];
  const ss = SpreadsheetApp.create("VCC season facts: captains' fixes");
  const sh = ss.getSheets()[0];
  sh.setName('Fixes');
  // Plain text, so dates, rounds and match ids stay as the page sent them.
  sh.getRange(1, 1, sh.getMaxRows(), FIX_COLS.length).setNumberFormat('@');
  sh.appendRow(FIX_COLS);
  sh.setFrozenRows(1);
  props.setProperty('FIXES_SHEET', ss.getId());
  return sh;
}

function fixRows_() {
  const sh = fixSheet_();
  const values = sh.getDataRange().getValues();
  return { sh, rows: values.slice(1).map((v, i) => ({ row: i + 2, fix: rowToFix_(v) })) };
}

function rowToFix_(v) {
  const f = {};
  FIX_COLS.forEach((c, i) => { f[c] = v[i] instanceof Date ? v[i].toISOString() : String(v[i] ?? ''); });
  try { f.edits = JSON.parse(f.edits || '[]'); } catch (err) { f.edits = []; }
  return f;
}

function fixToRow_(f) {
  return FIX_COLS.map(c => (c === 'edits' ? JSON.stringify(f.edits || []) : f[c] == null ? '' : String(f[c])));
}

function isAdmin_(key) {
  const k = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  return !!k && !!key && key === k;
}

function listFixes_(season, key) {
  const admin = isAdmin_(key);
  const { sh, rows } = fixRows_();
  return {
    fixes: rows.map(r => r.fix).filter(f => !season || f.season === String(season)),
    admin,
    sheet: admin ? sh.getParent().getUrl() : undefined,
  };
}

function saveFix_(req) {
  const text = (v, max) => String(v == null ? '' : v).slice(0, max);
  if (!req.key || !req.captain || !String(req.captain).trim()) throw new Error('A fix needs the issue and your name.');
  const props = PropertiesService.getScriptProperties();
  const day = today_();
  const count = props.getProperty('fixDay') === day ? Number(props.getProperty('fixCount') || 0) : 0;
  if (count >= FIX_DAILY_MAX) throw new Error('Too many fixes saved today. Try again tomorrow.');
  const edits = Array.isArray(req.edits) ? req.edits.slice(0, 20) : [];
  if (JSON.stringify(edits).length > 5000) throw new Error('This fix is too big to save.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { sh, rows } = fixRows_();
    const hit = rows.find(r => r.fix.key === req.key);
    const now = new Date().toISOString();
    const fix = {
      key: text(req.key, 600), season: text(req.season, 10), saved: hit ? hit.fix.saved : now, updated: now,
      captain: text(req.captain, 60).trim(), matchId: text(req.matchId, 20), date: text(req.date, 10), team: text(req.team, 80),
      opponent: text(req.opponent, 80), round: text(req.round, 10), grade: text(req.grade, 80), side: text(req.side, 80),
      type: text(req.type, 80), issue: text(req.issue, 600), fix: text(req.fix, 600), steps: text(req.steps, 4000), edits,
      status: req.status === 'done-rv' ? 'done-rv' : 'saved', note: '',
    };
    if (hit) sh.getRange(hit.row, 1, 1, FIX_COLS.length).setValues([fixToRow_(fix)]);
    else sh.appendRow(fixToRow_(fix));
    props.setProperties({ fixDay: day, fixCount: String(count + 1) });
    return { fix };
  } finally {
    lock.releaseLock();
  }
}

function setStatus_(req) {
  if (!isAdmin_(req.adminKey)) throw new Error('Only admins can change the status of a fix.');
  if (!FIX_STATUSES.includes(req.status)) throw new Error('Unknown status.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { sh, rows } = fixRows_();
    const hit = rows.find(r => r.fix.key === req.key);
    if (!hit) throw new Error('That fix is not in the Sheet any more.');
    const fix = { ...hit.fix, status: req.status, note: String(req.note || '').slice(0, 600), updated: new Date().toISOString() };
    sh.getRange(hit.row, 1, 1, FIX_COLS.length).setValues([fixToRow_(fix)]);
    return { fix };
  } finally {
    lock.releaseLock();
  }
}

function today_() {
  return Utilities.formatDate(new Date(), 'Europe/Amsterdam', 'yyyy-MM-dd');
}
