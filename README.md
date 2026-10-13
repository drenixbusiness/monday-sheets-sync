# Monday → Google Sheets sync

Syncs leads from the 10 Monday boards (New leads + Follow up for each HR) into the `Таблица1` table in Google Sheets.

| Sheet column | Source |
|---|---|
| Lead name | item name |
| Date | "Date contacted" column |
| Platform | "Platform" column |
| Status | "Status" column (on boards that have it, the `Status'` one) |
| HR Name | taken from which board the lead is on |
| Start Date | "Start date" — only on Follow up boards, empty otherwise |

Column A (hidden) holds the Monday item ID and matches rows to leads. **Don't delete it.**
When a lead moves from New leads to Follow up, its existing row is updated in place.

## How it works
- Every `POLL_SECONDS` (20s) it fetches all 10 boards' activity logs in **one** API call; if something changed it fetches only those leads (+1 call).
- Every `FULL_SYNC_MINUTES` (60) it does a full resync.
- Monday Pro limit: 10,000 calls/day. These settings use about 4,500–5,000.
- Edit board → column mappings in `src/config.js`.

## Running on the server
```bash
npm install
cp .env.example .env   # fill in the values
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup   # starts automatically when the server reboots
```
Logs: `pm2 logs monday-sheets-sync`

## Telegram
- `/start` — first person to send it becomes admin (or set `TELEGRAM_ADMIN_IDS` in `.env`)
- `/status` — status, number of leads, last change, API usage
- `/sync` — run a full sync now
- `/restart` — restart the bot

Self-recovery: on errors it retries with backoff; after 3 errors in a row it messages you on Telegram. If there's no successful sync for 15 minutes, the process exits itself and pm2 restarts it.
