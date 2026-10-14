const { mondayToken, BOARDS, BOARD_BY_ID, ALL_COLUMN_IDS, timeZone } = require('./config');

const API_URL = 'https://api.monday.com/v2';
const ITEM_FIELDS = `id name state board { id } column_values(ids: ${JSON.stringify(ALL_COLUMN_IDS)}) { id text value }`;

const stats = { callsToday: 0, day: new Date().toISOString().slice(0, 10) };

async function gql(query, variables = {}, attempt = 0) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== stats.day) Object.assign(stats, { day: today, callsToday: 0 });
  stats.callsToday++;

  let json;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: mondayToken, 'API-Version': '2024-10' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`Monday HTTP ${res.status}`);
    json = await res.json();
  } catch (e) {
    if (attempt < 4) {
      await sleep(2000 * 2 ** attempt);
      return gql(query, variables, attempt + 1);
    }
    throw e;
  }

  if (json.errors || json.error_code) {
    const msg = JSON.stringify(json.errors || json);
    if (/DAILY_LIMIT_EXCEEDED/.test(msg)) throw Object.assign(new Error('Monday daily API limit exceeded'), { dailyLimit: true });
    const retryable = /Complexity|RATE_LIMIT|Rate Limit|INTERNAL_SERVER/i.test(msg);
    if (retryable && attempt < 4) {
      await sleep(5000 * 2 ** attempt);
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`Monday API error: ${msg}`);
  }
  return json.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wall-clock date/time -> Google Sheets serial number (days since 1899-12-30).
const serial = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 864e5 + 25569;

// Monday stores date column time in UTC; convert it to `timeZone` wall-clock.
const tzParts = new Intl.DateTimeFormat('en-US', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Monday date column value -> { serial, hasTime } or '' if empty.
function parseDate(cv) {
  if (!cv?.value) return '';
  let v;
  try { v = JSON.parse(cv.value); } catch { return ''; }
  if (!v?.date) return '';
  const [y, mo, d] = v.date.split('-').map(Number);
  if (!v.time) return { serial: serial(y, mo, d), hasTime: false };
  const [h, mi] = v.time.split(':').map(Number);
  const p = Object.fromEntries(tzParts.formatToParts(new Date(Date.UTC(y, mo - 1, d, h, mi))).map((x) => [x.type, Number(x.value)]));
  return { serial: serial(p.year, p.month, p.day, p.hour, p.minute), hasTime: true };
}

// Monday item -> { name, date, dateContacted, platform, status, hr, startDate, notes }
function toRow(item) {
  const board = BOARD_BY_ID[item.board?.id];
  if (!board || item.state !== 'active') return null;
  const cv = (key) => item.column_values.find((c) => c.id === board.cols[key]);
  const text = (key) => [board.cols[key] || []].flat()
    .map((id) => (item.column_values.find((c) => c.id === id)?.text || '').trim())
    .find(Boolean) || '';
  return {
    name: item.name.trim(),
    date: parseDate(cv('date')),
    dateContacted: parseDate(cv('dateContacted')),
    platform: text('platform'),
    status: text('status'),
    hr: board.hr,
    startDate: board.type === 'followup' ? text('startDate') : '',
    notes: text('notes'),
  };
}

// Fetch every item of every configured board. Returns Map<itemId, row>.
async function fetchAll() {
  const rows = new Map();
  for (const board of BOARDS) {
    let data = await gql(
      `query($b: [ID!]) { boards(ids: $b) { items_page(limit: 500) { cursor items { ${ITEM_FIELDS} } } } }`,
      { b: [board.id] },
    );
    let page = data.boards[0].items_page;
    for (;;) {
      for (const item of page.items) {
        const row = toRow(item);
        if (row) rows.set(item.id, row);
      }
      if (!page.cursor) break;
      data = await gql(
        `query($c: String!) { next_items_page(limit: 500, cursor: $c) { cursor items { ${ITEM_FIELDS} } } }`,
        { c: page.cursor },
      );
      page = data.next_items_page;
    }
  }
  return rows;
}

// Fetch specific items. Returns Map<itemId, row|null>; null = item gone / archived / moved off our boards.
async function fetchItems(ids) {
  const result = new Map(ids.map((id) => [String(id), null]));
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await gql(`query($ids: [ID!]) { items(ids: $ids, limit: 100) { ${ITEM_FIELDS} } }`, { ids: chunk });
    for (const item of data.items) result.set(item.id, toRow(item));
  }
  return result;
}

// One API call: activity logs of all boards since `from`.
// Returns { needFullSync: bool, logs: [{ id, event, data, created_at }] }
async function fetchChanges(from) {
  const data = await gql(
    `query($b: [ID!], $f: ISO8601DateTime) { boards(ids: $b) { id activity_logs(from: $f, limit: 500) { id event data created_at } } }`,
    { b: BOARDS.map((b) => b.id), f: from.toISOString() },
  );
  const logs = [];
  let needFullSync = false;

  for (const board of data.boards) {
    if (board.activity_logs.length >= 500) needFullSync = true; // too many changes, just resync everything
    for (const log of board.activity_logs) {
      logs.push(log);
      if (/^batch_/.test(log.event) && !/"pulse_ids"/.test(log.data)) needFullSync = true;
    }
  }
  return { needFullSync, logs };
}

module.exports = { fetchAll, fetchItems, fetchChanges, stats };
