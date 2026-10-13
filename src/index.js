const sync = require('./sync');
const telegram = require('./telegram');
const { pollSeconds } = require('./config');

const fmt = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Tashkent' }) : '—');
const ago = (d) => (d ? `${Math.round((Date.now() - new Date(d)) / 1000)}s oldin` : '—');

function statusText() {
  const s = sync.state;
  return [
    s.consecutiveErrors ? '🔴 <b>Xato bor</b>' : '🟢 <b>Ishlayapti</b>',
    `Sheet'dagi leadlar: <b>${s.rowsInSheet}</b>`,
    `Oxirgi muvaffaqiyatli tekshiruv: ${ago(s.lastSuccess)}`,
    `Oxirgi to'liq sync: ${fmt(s.lastFullSync)}`,
    `Oxirgi o'zgarish: ${s.lastChange ? `${fmt(s.lastChange.at)} (${s.lastChange.items} ta lead)` : '—'}`,
    `Monday API bugun: ${sync.stats.callsToday} call (limit 10,000)`,
    `Ishga tushgan: ${fmt(s.startedAt)}`,
    s.lastError ? `\nOxirgi xato (${fmt(s.lastErrorAt)}):\n<code>${s.lastError.slice(0, 500)}</code>` : '',
  ].join('\n');
}

function restart(reason) {
  console.error('Restarting:', reason);
  // Exit with error code; pm2 / systemd / docker brings the process back up.
  telegram.notifyAdmins(`♻️ Bot qayta ishga tushirilmoqda: ${reason}`).finally(() => setTimeout(() => process.exit(1), 1000));
}

async function main() {
  telegram.start({
    status: async () => statusText(),
    sync: async (chatId, send) => {
      await send(chatId, '⏳ To\'liq sync boshlandi...');
      await sync.syncNow();
      return sync.state.consecutiveErrors ? `❌ Sync xato: ${sync.state.lastError}` : `✅ Tayyor. Sheet'da ${sync.state.rowsInSheet} ta lead.`;
    },
    restart: async () => { restart('/restart buyrug\'i'); return null; },
    help: async () => '/status — holat\n/sync — to\'liq sync\n/restart — qayta ishga tushirish',
  }).catch((e) => console.error('Telegram stopped:', e));

  let errorNotified = false;
  await sync.start((event, state, err) => {
    // Notify once when sync starts failing (3 errors in a row), and once when it recovers.
    if (event === 'error' && state.consecutiveErrors === 3 && !errorNotified) {
      errorNotified = true;
      telegram.notifyAdmins(`🔴 Sync ishlamayapti (3 marta ketma-ket xato):\n<code>${String(err.message).slice(0, 500)}</code>`);
    }
    if (event === 'recovered' && errorNotified) {
      errorNotified = false;
      telegram.notifyAdmins('🟢 Sync qayta ishlayapti.');
    }
  });

  console.log(`Started. Polling Monday every ${pollSeconds}s.`);
  telegram.notifyAdmins(`🚀 Bot ishga tushdi. Sheet'da ${sync.state.rowsInSheet} ta lead.`);

  // Watchdog: if nothing succeeded for 15 minutes, restart the whole process.
  setInterval(() => {
    const last = sync.state.lastSuccess || sync.state.startedAt;
    if (Date.now() - last > 15 * 60_000) restart('15 daqiqadan beri sync muvaffaqiyatsiz');
  }, 60_000);
}

process.on('unhandledRejection', (e) => restart(`unhandledRejection: ${e?.message || e}`));
process.on('uncaughtException', (e) => restart(`uncaughtException: ${e.message}`));

main().catch((e) => restart(`startup: ${e.message}`));
