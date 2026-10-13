const { google } = require('googleapis');
const { sheetId, sheetName, googleEmail, googleKey } = require('./config');

// Layout: column A = Monday item ID (hidden, used for matching),
// columns B..G = the "Таблица1" table: Lead name | Date | Platform | Status | HR Name | Start Date
const auth = new google.auth.JWT({ email: googleEmail, key: googleKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const api = google.sheets({ version: 'v4', auth });
const q = `'${sheetName}'`;

let meta = null; // { gridId, rowCount, tableId }

async function loadMeta() {
  const res = await api.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets(properties,tables)' });
  const sheet = res.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet tab "${sheetName}" not found`);
  meta = {
    gridId: sheet.properties.sheetId,
    rowCount: sheet.properties.gridProperties.rowCount,
    table: sheet.tables?.[0] || null,
  };
  return meta;
}

// One-time layout: ID header in A1, column A hidden, Date column formatted as yyyy-mm-dd.
async function setup() {
  await loadMeta();
  await api.spreadsheets.values.update({
    spreadsheetId: sheetId, range: `${q}!A1`, valueInputOption: 'RAW', requestBody: { values: [['Monday ID']] },
  });
  await api.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          updateDimensionProperties: {
            range: { sheetId: meta.gridId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
            properties: { hiddenByUser: true }, fields: 'hiddenByUser',
          },
        },
        {
          repeatCell: {
            range: { sheetId: meta.gridId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
            cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
      ],
    },
  });
}

// Reads A2:G. Returns [{ row (1-based), id, values[6] }]
async function readRows() {
  const res = await api.spreadsheets.values.get({
    spreadsheetId: sheetId, range: `${q}!A2:G`, valueRenderOption: 'FORMATTED_VALUE',
  });
  return (res.data.values || []).map((r, i) => ({
    row: i + 2,
    id: String(r[0] || '').trim(),
    values: Array.from({ length: 6 }, (_, k) => String(r[k + 1] ?? '')),
  }));
}

const same = (a, b) => a.every((v, i) => String(v).trim() === String(b[i] ?? '').trim());

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

  for (const r of rows) {
    if (!r.id) {
      if (r.values.every((v) => v === '')) freeRows.push(r.row);
      continue;
    }
    if (byId.has(r.id)) { toDelete.push(r.row); continue; } // duplicate row
    byId.set(r.id, r);
  }

  const updates = []; // { row, id, values }
  const appends = []; // { id, values }
  for (const [id, values] of desired) {
    const existing = byId.get(id);
    if (!values) { if (existing) toDelete.push(existing.row); continue; }
    if (existing) { if (!same(values, existing.values)) updates.push({ row: existing.row, id, values }); }
    else if (freeRows.length) updates.push({ row: freeRows.shift(), id, values });
    else appends.push({ id, values });
  }
  if (full) for (const [id, r] of byId) if (!desired.has(id)) toDelete.push(r.row);

  const lastUsed = rows.length + 1; // last row of sheet data (incl. header)
  const lastRowAfter = lastUsed + appends.length;

  // Make sure the grid has enough rows.
  if (lastRowAfter > meta.rowCount) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: meta.gridId, dimension: 'ROWS', length: lastRowAfter - meta.rowCount + 500 } }] },
    });
  }

  const data = updates.map((u) => ({ range: `${q}!A${u.row}:G${u.row}`, values: [[u.id, ...u.values]] }));
  if (appends.length) {
    data.push({ range: `${q}!A${lastUsed + 1}:G${lastRowAfter}`, values: appends.map((a) => [a.id, ...a.values]) });
  }
  for (let i = 0; i < data.length; i += 500) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: data.slice(i, i + 500) },
    });
  }

  // Grow the table so new rows are inside "Таблица1".
  if (meta.table && appends.length) {
    const range = { ...meta.table.range, sheetId: meta.gridId, endRowIndex: Math.max(meta.table.range.endRowIndex, lastRowAfter) };
    await api.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ updateTable: { table: { tableId: meta.table.tableId, range }, fields: 'range' } }] },
    });
  }

  // Delete bottom-up so row numbers stay valid.
  const del = [...new Set(toDelete)].sort((a, b) => b - a);
  for (let i = 0; i < del.length; i += 500) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: del.slice(i, i + 500).map((r) => ({
          deleteDimension: { range: { sheetId: meta.gridId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } },
        })),
      },
    });
  }

  return { written: updates.length, appended: appends.length, deleted: del.length };
}

module.exports = { setup, apply };
