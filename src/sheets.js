const { google } = require('googleapis');
const { sheetId, sheetName, googleEmail, googleKey } = require('./config');

// The tab and its columns are found by header text in row 1, so tabs can be renamed and columns moved/added.
// "Monday ID" (hidden; created after the last column if missing) matches rows to Monday items.
const HEADERS = {
  id: 'monday id',
  name: 'lead name',
  date: 'date',
  dateContacted: 'date contacted',
  platform: 'platform',
  status: 'status',
  hr: 'hr name',
  startDate: 'start date',
};
const DATE_FORMAT = { type: 'DATE', pattern: 'mmm d, yyyy' };
const DATE_TIME_FORMAT = { type: 'DATE_TIME', pattern: 'mmm d, yyyy, h:mm AM/PM' };

const auth = new google.auth.JWT({ email: googleEmail, key: googleKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const api = google.sheets({ version: 'v4', auth });
let meta = null; // { title, q, gridId, rowCount, table, cols: { field: colIndex }, idMissing }

const colLetter = (i) => (i >= 26 ? colLetter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

const quote = (title) => `'${title.replace(/'/g, "''")}'`;

// Picks the tab: GOOGLE_SHEET_TAB if it exists, otherwise the first tab whose row 1 has "Lead name" and "HR Name".
async function loadMeta() {
  const res = await api.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets(properties,tables)' });
  const heads = await api.spreadsheets.values.batchGet({
    spreadsheetId: sheetId, ranges: res.data.sheets.map((sh) => `${quote(sh.properties.title)}!1:1`),
  });
  const tabs = res.data.sheets.map((sh, i) => ({
    sheet: sh,
    header: (heads.data.valueRanges[i].values?.[0] || []).map((h) => String(h).trim().toLowerCase()),
  }));
  const tab = tabs.find((t) => t.sheet.properties.title === sheetName)
    || tabs.find((t) => t.header.includes(HEADERS.name) && t.header.includes(HEADERS.hr));
  if (!tab) throw new Error('No tab with "Lead name" and "HR Name" headers found in the spreadsheet');
  const { sheet, header } = tab;

  const cols = {};
  for (const [field, title] of Object.entries(HEADERS)) {
    const i = header.indexOf(title);
    if (i >= 0) cols[field] = i;
  }
  const idMissing = cols.id === undefined;
  if (idMissing) cols.id = header.length; // first empty column after the headers
  const missing = Object.keys(HEADERS).filter((f) => cols[f] === undefined);
  if (missing.length) throw new Error(`Sheet header not found: ${missing.map((f) => HEADERS[f]).join(', ')}`);

  meta = {
    title: sheet.properties.title,
    q: quote(sheet.properties.title),
    idMissing,
    gridId: sheet.properties.sheetId,
    rowCount: sheet.properties.gridProperties.rowCount,
    table: sheet.tables?.[0] || null,
    cols,
    lastCol: Math.max(...Object.values(cols)),
  };
  return meta;
}

// One-time layout: English locale (dates as "Jan 18, 2026"), ID header, ID column hidden.
async function setup() {
  await api.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ updateSpreadsheetProperties: { properties: { locale: 'en_US' }, fields: 'locale' } }] },
  });
  await loadMeta();
  const idCol = meta.cols.id;
  if (meta.idMissing) {
    await api.spreadsheets.values.update({
      spreadsheetId: sheetId, range: `${meta.q}!${colLetter(idCol)}1`, valueInputOption: 'RAW', requestBody: { values: [['Monday ID']] },
    });
  }
  await api.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        updateDimensionProperties: {
          range: { sheetId: meta.gridId, dimension: 'COLUMNS', startIndex: idCol, endIndex: idCol + 1 },
          properties: { hiddenByUser: true }, fields: 'hiddenByUser',
        },
      }],
    },
  });
}

// Reads all data rows. Dates come back as serial numbers. Returns [{ row (1-based), id, cells: { field: value } }]
async function readRows() {
  const res = await api.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${meta.q}!A2:${colLetter(meta.lastCol)}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  return (res.data.values || []).map((r, i) => {
    const cells = {};
    for (const [field, col] of Object.entries(meta.cols)) cells[field] = r[col] ?? '';
    return { row: i + 2, id: String(cells.id).trim(), cells };
  });
}

function sameCell(want, have) {
  if (want && typeof want === 'object') return typeof have === 'number' && Math.abs(have - want.serial) < 1e-5;
  return String(want).trim() === String(have).trim();
}
const sameRow = (item, cells) => Object.keys(item).every((f) => sameCell(item[f], cells[f]));

// Identifies a lead without its Monday ID: name + HR + Date Contacted.
function matchKey(v) {
  const dc = v.dateContacted && typeof v.dateContacted === 'object' ? v.dateContacted.serial : v.dateContacted;
  return [String(v.name).trim().toLowerCase(), String(v.hr).trim().toLowerCase(), dc === '' ? '' : Math.round(Number(dc))].join('|');
}

function toCell(v) {
  if (v && typeof v === 'object') {
    return { userEnteredValue: { numberValue: v.serial }, userEnteredFormat: { numberFormat: v.hasTime ? DATE_TIME_FORMAT : DATE_FORMAT } };
  }
  return v === '' ? {} : { userEnteredValue: { stringValue: String(v) } };
}

// updateCells requests for rows starting at `startRow` (1-based). Only our columns are touched:
// consecutive mapped columns are written as one block, other columns are left alone.
function writeRequests(startRow, items) {
  const fields = Object.keys(meta.cols).sort((a, b) => meta.cols[a] - meta.cols[b]);
  const segments = [];
  for (const f of fields) {
    const last = segments[segments.length - 1];
    if (last && meta.cols[f] === last.end) { last.fields.push(f); last.end++; }
    else segments.push({ start: meta.cols[f], end: meta.cols[f] + 1, fields: [f] });
  }
  return segments.map((seg) => ({
    updateCells: {
      range: { sheetId: meta.gridId, startRowIndex: startRow - 1, endRowIndex: startRow - 1 + items.length, startColumnIndex: seg.start, endColumnIndex: seg.end },
      rows: items.map((it) => ({ values: seg.fields.map((f) => toCell(it[f])) })),
      fields: 'userEnteredValue,userEnteredFormat.numberFormat',
    },
  }));
}

async function batch(requests) {
  for (let i = 0; i < requests.length; i += 500) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: requests.slice(i, i + 500) } });
  }
}

/**
 * Apply Monday state to the sheet.
 * @param desired Map<itemId, row|null>  (null = remove)
 * @param full    if true, any sheet row whose ID is not in `desired` is removed too
 * Keeps existing row positions (so manual sorting in the sheet is respected), fills empty rows first,
 * then appends at the bottom.
 */
async function apply(desired, { full = false } = {}) {
  await loadMeta();
  const rows = await readRows();
  const byId = new Map();
  const freeRows = [];
  const toDelete = [];
  const orphans = new Map(); // rows with data but no Monday ID (e.g. ID column was deleted), by matchKey

  for (const r of rows) {
    if (!r.id) {
      if (Object.values(r.cells).every((v) => v === '')) freeRows.push(r.row);
      else {
        const k = matchKey(r.cells);
        if (!orphans.has(k)) orphans.set(k, []);
        orphans.get(k).push(r);
      }
      continue;
    }
    if (byId.has(r.id)) { toDelete.push(r.row); continue; } // duplicate row
    byId.set(r.id, r);
  }

  const updates = []; // { row, item }
  const appends = []; // item
  for (const [id, values] of desired) {
    let existing = byId.get(id);
    if (!values) { if (existing) toDelete.push(existing.row); continue; }
    if (!existing) existing = orphans.get(matchKey(values))?.shift(); // re-attach row that lost its ID
    const item = { id, ...values };
    if (existing) { if (!sameRow(item, existing.cells)) updates.push({ row: existing.row, item }); }
    else if (freeRows.length) updates.push({ row: freeRows.shift(), item });
    else appends.push(item);
  }
  if (full) for (const [id, r] of byId) if (!desired.has(id)) toDelete.push(r.row);

  const lastUsed = rows.length + 1; // last row of sheet data (incl. header)
  const lastRowAfter = lastUsed + appends.length;

  // Make sure the grid has enough rows.
  if (lastRowAfter > meta.rowCount) {
    await batch([{ appendDimension: { sheetId: meta.gridId, dimension: 'ROWS', length: lastRowAfter - meta.rowCount + 500 } }]);
  }

  const requests = updates.flatMap((u) => writeRequests(u.row, [u.item]));
  if (appends.length) requests.push(...writeRequests(lastUsed + 1, appends));
  await batch(requests);

  // Grow the table so new rows are inside "Таблица1".
  if (meta.table && appends.length) {
    const range = { ...meta.table.range, sheetId: meta.gridId, endRowIndex: Math.max(meta.table.range.endRowIndex, lastRowAfter) };
    await batch([{ updateTable: { table: { tableId: meta.table.tableId, range }, fields: 'range' } }]);
  }

  // Delete bottom-up so row numbers stay valid.
  const del = [...new Set(toDelete)].sort((a, b) => b - a);
  await batch(del.map((r) => ({
    deleteDimension: { range: { sheetId: meta.gridId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } },
  })));

  return { written: updates.length, appended: appends.length, deleted: del.length, tab: meta.title };
}

module.exports = { setup, apply };
