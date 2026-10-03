// Lets anyone on the season page reload all data ("Refresh data" workflow, every scorecard downloaded again),
// without a GitHub account.
// Runs as a Google Apps Script web app (Execute as: me, Who has access: Anyone).
// Script property GITHUB_TOKEN: a fine-grained GitHub token for this repository only, with "Actions: Read and write".
//
//   GET  ?action=status   -> { busy, run, cooldownMin, leftToday }
//   POST                  -> { state: started | running | cooldown | limit | error, ... }
//
// One fetch at a time: a script lock makes simultaneous presses see the same run instead of starting two.

const REPO = 'birdy10/VCC-Jaarverslag-2026';
const WORKFLOW = 'refresh.yml';
const COOLDOWN_MIN = 10; // no new fetch within 10 minutes of the start of the previous one
const DAILY_MAX = 30;    // fetches started from the page per day (Amsterdam time)

function doGet(e) {
  return respond_(() => status_());
}

function doPost() {
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

function today_() {
  return Utilities.formatDate(new Date(), 'Europe/Amsterdam', 'yyyy-MM-dd');
}
