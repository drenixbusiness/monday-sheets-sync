require('dotenv').config({ quiet: true });

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env variable: ${name}`);
  return v;
}

// Each HR has two boards: "new" (New leads) and "followup" (Follow up).
// Column IDs differ between boards, so they are listed explicitly.
// Start Date is only read from follow-up boards; on new-lead boards it stays empty.
// A column can be a list of IDs: the first non-empty one is used.
const BOARDS = [
  // Alex Chester
  { id: '1975685235', hr: 'Alex Chester', type: 'new', cols: { date: 'date_mkr8ym80', dateContacted: 'date_mkraat8n', platform: 'text9', status: 'color_mkr6he2a', notes: 'text_mkr71cdz' } },
  { id: '1982791767', hr: 'Alex Chester', type: 'followup', cols: { date: 'date_mkr8ym80', dateContacted: 'date_mkraat8n', platform: 'text9', status: 'color_mkr6he2a', startDate: 'color_mkr6rcmc', notes: 'text_mkr71cdz' } },
  // Winston
  { id: '5023206586', hr: 'Winston', type: 'new', cols: { date: 'date_mkr8bc5', dateContacted: 'date_mkr6r9yv', platform: 'text9', status: 'color_mkr7p7bm', notes: 'text_mkr6z3zc' } },
  { id: '5023206983', hr: 'Winston', type: 'followup', cols: { date: 'date_mkr8ym80', dateContacted: 'date_mkraat8n', platform: 'text9', status: 'color_mkrfhs3d', startDate: 'color_mkr6rcmc', notes: 'text_mkr71cdz' } },
  // Isaac
  { id: '1975765917', hr: 'Isaac', type: 'new', cols: { date: 'date_mkr8bc5', dateContacted: 'date_mkr6r9yv', platform: 'text9', status: 'color_mkr7p7bm', notes: ['text_mkr6z3zc', 'text_mm4gp6ah'] } },
  { id: '1982847753', hr: 'Isaac', type: 'followup', cols: { date: 'date_mkr8ym80', dateContacted: 'date_mkraat8n', platform: 'text9', status: 'color_mkrfhs3d', startDate: 'color_mkr6rcmc', notes: 'text_mkr71cdz' } },
  // Tim Baker
  { id: '5101948793', hr: 'Tim Baker', type: 'new', cols: { date: 'date_mkr8bc5', dateContacted: 'date_mkr6r9yv', platform: 'text9', status: 'color_mkr7p7bm', notes: 'text_mkr6z3zc' } },
  { id: '5101948852', hr: 'Tim Baker', type: 'followup', cols: { date: 'date_mkr8ym80', dateContacted: 'date_mkraat8n', platform: 'text9', status: 'color_mkrfhs3d', startDate: 'color_mkr6rcmc', notes: 'text_mkr71cdz' } },
  // Simon Cooper
  { id: '5101948870', hr: 'Simon Cooper', type: 'new', cols: { date: 'date_mkr8bc5', dateContacted: 'date_mkr6r9yv', platform: 'text9', status: 'color_mkr7p7bm', notes: 'text_mkr6z3zc' } },
  { id: '5101948914', hr: 'Simon Cooper', type: 'followup', cols: { date: 'date_mkr8ym80', dateContacted: 'date_mkraat8n', platform: 'text9', status: 'color_mkrfhs3d', startDate: 'color_mkr6rcmc', notes: 'text_mkr71cdz' } },
];

module.exports = {
  BOARDS,
  BOARD_BY_ID: Object.fromEntries(BOARDS.map((b) => [b.id, b])),
  ALL_COLUMN_IDS: [...new Set(BOARDS.flatMap((b) => Object.values(b.cols).flat()))],

  mondayToken: required('MONDAY_TOKEN'),
  sheetId: required('GOOGLE_SHEET_ID'),
  // Empty = find the tab automatically by its headers (Lead name, HR Name, ...).
  sheetName: process.env.GOOGLE_SHEET_TAB || '',
  googleEmail: required('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
  googleKey: required('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n'),

  // Timezone used to show Monday "Date" times in the sheet.
  timeZone: process.env.SHEET_TIMEZONE || 'Asia/Tashkent',

  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAdmins: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Pro plan = 10,000 Monday API calls/day. One poll = 1 call (+1 when something changed).
  // 20s poll ≈ 4,300 calls/day, hourly full sync ≈ 350 calls/day.
  pollSeconds: Number(process.env.POLL_SECONDS || 20),
  fullSyncMinutes: Number(process.env.FULL_SYNC_MINUTES || 60),
};
