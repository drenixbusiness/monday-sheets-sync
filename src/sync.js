const monday = require('./monday');
const sheets = require('./sheets');
const { pollSeconds, fullSyncMinutes } = require('./config');

const state = {
  startedAt: new Date(),
  lastSuccess: null,
  lastFullSync: null,
  lastError: null,
  lastErrorAt: null,
  consecutiveErrors: 0,
  rowsInSheet: 0,
  lastChange: null, // { at, items }
  fullSyncRequested: true,
};

let cursor = null; // activity logs are read from this time
const seenLogs = new Map(); // log id -> timestamp, to skip logs already processed (we re-read with overlap)
let running = null;
let timer = null;
let onEvent = () => {};

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function fullSync() {
  const started = new Date();
  const rows = await monday.fetchAll();
  const res = await sheets.apply(rows, { full: true });
  state.lastFullSync = new Date();
  state.rowsInSheet = rows.size;
  state.fullSyncRequested = false;
  cursor = new Date(started.getTime() - 60_000);
  log(`Full sync: ${rows.size} leads, written ${res.written}, appended ${res.appended}, deleted ${res.deleted}`);
  return res;
}

async function incrementalSync() {
  const now = Date.now();
  const { needFullSync, logs } = await monday.fetchChanges(cursor);

  const fresh = logs.filter((l) => !seenLogs.has(l.id));
  logs.forEach((l) => seenLogs.set(l.id, now));
  for (const [id, t] of seenLogs) if (now - t > 15 * 60_000) seenLogs.delete(id);
  // Overlap by 60s: activity logs can show up with a small delay.
  cursor = new Date(now - 60_000);

  if (needFullSync) return fullSync();
  if (!fresh.length) return null;

  const ids = new Set();
  for (const l of fresh) {
    try {
      const d = JSON.parse(l.data);
      [d.pulse_id, d.pulse?.id, ...(d.pulse_ids || [])].filter(Boolean).forEach((id) => ids.add(String(id)));
    } catch { /* ignore */ }
  }
  if (!ids.size) return null;

  const rows = await monday.fetchItems([...ids]);
  const res = await sheets.apply(rows);
  state.lastChange = { at: new Date(), items: ids.size };
  log(`Changes in ${ids.size} item(s): written ${res.written}, appended ${res.appended}, deleted ${res.deleted}`);
  return res;
}

async function tick() {
  if (running) return running;
  running = (async () => {
    try {
      const due = !state.lastFullSync || Date.now() - state.lastFullSync > fullSyncMinutes * 60_000;
      if (state.fullSyncRequested || due || !cursor) await fullSync();
      else await incrementalSync();
      if (state.consecutiveErrors > 0) onEvent('recovered', state);
      state.lastSuccess = new Date();
      state.consecutiveErrors = 0;
    } catch (e) {
      state.consecutiveErrors++;
      state.lastError = e.message;
      state.lastErrorAt = new Date();
      log('Sync error:', e.message);
      onEvent('error', state, e);
    } finally {
      running = null;
    }
  })();
  return running;
}

function loop() {
  // Back off when errors repeat (max 5 min), e.g. when Monday or Google is down.
  const delay = Math.min(pollSeconds * 1000 * 2 ** state.consecutiveErrors, 5 * 60_000);
  timer = setTimeout(async () => { await tick(); loop(); }, delay);
}

async function start(handler) {
  if (handler) onEvent = handler;
  await sheets.setup();
  await tick();
  loop();
}

// Force a full resync now (used by /sync).
async function syncNow() {
  state.fullSyncRequested = true;
  if (running) await running; // let the current run finish, then do the full one
  await tick();
  return state;
}

module.exports = { start, syncNow, state, stats: monday.stats };
