// Lets anyone on the season page reload all data ("Refresh data" workflow, every scorecard downloaded again),
// without a GitHub account, and saves the fixes captains make with "Fix it" in the repository itself:
// data/fixes-<season>.json, one commit per save (which also rebuilds the page). Admins are the names in
// data/admins.json; captains and admins are known by the name they type on the page.
// Runs as a Google Apps Script web app (Execute as: me, Who has access: Anyone).
// Script property GITHUB_TOKEN: a fine-grained GitHub token for this repository only, with
// "Actions: Read and write" (reloads) and "Contents: Read and write" (fixes).
//
//   GET  ?action=status                  -> { busy, run, cooldownMin, leftToday }
//   GET  ?action=fixes&season=2026       -> { fixes: [...], admins: [...] }
//   POST {"action":"saveFix", ...}       -> { fix }   one fix per issue: saving again replaces it
//   POST {"action":"setStatus", key, status, note, by} -> { fix }   only for names in data/admins.json
//   POST (anything else)                 -> { state: started | running | cooldown | limit | error, ... }
//
// One fetch at a time: a script lock makes simultaneous presses see the same run instead of starting two.
// The page posts as text/plain, so browsers send it without a CORS preflight (which Apps Script can't answer).

const REPO = 'birdy10/VCC-Jaarverslag-2026';
const WORKFLOW = 'refresh.yml';
const COOLDOWN_MIN = 10; // no new fetch within 10 minutes of the start of the previous one
const DAILY_MAX = 30;    // fetches started from the page per day (Amsterdam time)

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'fixes') return respond_(() => listFixes_(p.season));
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
// One entry per issue (key = match id|type|issue text) in data/fixes-<season>.json on main.
const FIX_STATUSES = ['saved', 'confirmed', 'rejected'];
const FIX_DAILY_MAX = 500; // saves per day, against a runaway script

// A JSON file from main, with its sha (needed to write it back); null when it isn't there yet.
function readRepoJson_(path) {
  let res;
  try { res = gh_('get', `/contents/${path}?ref=main`); } catch (err) {
    if (/answered 404/.test(err.message)) return { sha: null, json: null };
    throw err;
  }
  // Files over 1 MB come without content: fetch those raw.
  const text = res.content
    ? Utilities.newBlob(Utilities.base64Decode(res.content.replace(/\n/g, ''))).getDataAsString('UTF-8')
    : UrlFetchApp.fetch(res.download_url).getContentText('UTF-8');
  return { sha: res.sha, json: JSON.parse(text) };
}

function writeRepoJson_(path, json, sha, message) {
  const body = { message, branch: 'main', content: Utilities.base64Encode(JSON.stringify(json, null, 1) + '\n', Utilities.Charset.UTF_8) };
  if (sha) body.sha = sha;
  gh_('put', `/contents/${path}`, body);
}

const fixesPath_ = season => `data/fixes-${String(season).replace(/\D/g, '')}.json`;

function admins_() {
  const { json } = readRepoJson_('data/admins.json');
  return ((json && json.admins) || []).map(String);
}

function listFixes_(season) {
  const { json } = readRepoJson_(fixesPath_(season || '2026'));
  return { fixes: (json && json.fixes) || [], admins: admins_() };
}

// Read, change one fix, write back; the script lock keeps two saves from overwriting each other.
function updateFixes_(season, change, message) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const path = fixesPath_(season);
    const { sha, json } = readRepoJson_(path);
    const file = json || { about: "Captains' fixes saved on the season page. Written by refresh-service/Code.gs.", fixes: [] };
    const fix = change(file.fixes);
    writeRepoJson_(path, file, sha, message(fix));
    return { fix };
  } finally {
    lock.releaseLock();
  }
}

function saveFix_(req) {
  const text = (v, max) => String(v == null ? '' : v).slice(0, max);
  const captain = text(req.captain, 60).trim();
  if (!req.key || !captain) throw new Error('A fix needs the issue and your name.');
  const props = PropertiesService.getScriptProperties();
  const day = today_();
  const count = props.getProperty('fixDay') === day ? Number(props.getProperty('fixCount') || 0) : 0;
  if (count >= FIX_DAILY_MAX) throw new Error('Too many fixes saved today. Try again tomorrow.');
  const edits = Array.isArray(req.edits) ? req.edits.slice(0, 20) : [];
  if (JSON.stringify(edits).length > 5000) throw new Error('This fix is too big to save.');
  const res = updateFixes_(req.season, fixes => {
    const i = fixes.findIndex(f => f.key === req.key);
    const now = new Date().toISOString();
    const fix = {
      key: text(req.key, 600), saved: now, updated: now, captain, status: 'saved',
      matchId: text(req.matchId, 20), date: text(req.date, 10), team: text(req.team, 80), opponent: text(req.opponent, 80),
      round: text(req.round, 10), grade: text(req.grade, 80), side: text(req.side, 80), type: text(req.type, 80),
      issue: text(req.issue, 600), fix: text(req.fix, 600), steps: text(req.steps, 4000), edits,
    };
    if (i >= 0) fixes[i] = fix; else fixes.push(fix);
    return fix;
  }, fix => `Fix: ${fix.team} v ${fix.opponent}, ${fix.type} (${fix.captain})`);
  props.setProperties({ fixDay: day, fixCount: String(count + 1) });
  return res;
}

function setStatus_(req) {
  const by = String(req.by || '').trim();
  if (!by || !admins_().some(a => a.trim().toLowerCase() === by.toLowerCase())) throw new Error(`${by || 'Nobody'} is not in the admins list (data/admins.json).`);
  if (!FIX_STATUSES.includes(req.status)) throw new Error('Unknown status.');
  return updateFixes_(req.season, fixes => {
    const f = fixes.find(x => x.key === req.key);
    if (!f) throw new Error('That fix is not saved any more.');
    Object.assign(f, { status: req.status, by: req.status === 'saved' ? '' : by, note: String(req.note || '').slice(0, 600), updated: new Date().toISOString() });
    return f;
  }, fix => `Fix ${fix.status === 'saved' ? 'reopened' : fix.status}: ${fix.team} v ${fix.opponent}, ${fix.type} (${by})`);
}

function today_() {
  return Utilities.formatDate(new Date(), 'Europe/Amsterdam', 'yyyy-MM-dd');
}
