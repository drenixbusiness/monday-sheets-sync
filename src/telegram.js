const fs = require('fs');
const path = require('path');
const { telegramToken, telegramAdmins } = require('./config');

// Admins come from TELEGRAM_ADMIN_IDS. If that is empty, the first person who sends /start
// becomes the admin and is saved to data/admins.json (nobody else can use the bot after that).
const ADMINS_FILE = path.join(__dirname, '..', 'data', 'admins.json');
const API = `https://api.telegram.org/bot${telegramToken}`;

let admins = new Set(telegramAdmins);
if (!admins.size && fs.existsSync(ADMINS_FILE)) admins = new Set(JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')));

function saveAdmins() {
  fs.mkdirSync(path.dirname(ADMINS_FILE), { recursive: true });
  fs.writeFileSync(ADMINS_FILE, JSON.stringify([...admins]));
}

async function call(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

const send = (chatId, text) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch((e) => console.error(e.message));

async function notifyAdmins(text) {
  if (!telegramToken) return;
  await Promise.all([...admins].map((id) => send(id, text)));
}

/** commands: { name: async (chatId) => replyText } */
async function start(commands) {
  if (!telegramToken) return console.log('TELEGRAM_BOT_TOKEN not set, Telegram bot disabled');
  await call('setMyCommands', {
    commands: [
      { command: 'status', description: 'Sync holati' },
      { command: 'sync', description: "To'liq sync'ni hozir ishga tushirish" },
      { command: 'restart', description: 'Botni qayta ishga tushirish' },
    ],
  }).catch((e) => console.error(e.message));

  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
    } catch (e) {
      console.error(e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text) continue;
      const chatId = String(msg.chat.id);
      const cmd = msg.text.trim().split(/[\s@]/)[0].replace('/', '').toLowerCase();

      if (!admins.size && cmd === 'start') {
        admins.add(chatId);
        saveAdmins();
        await send(chatId, '✅ Siz admin sifatida qo\'shildingiz.\n\n/status — holat\n/sync — to\'liq sync\n/restart — qayta ishga tushirish');
        continue;
      }
      if (!admins.has(chatId)) {
        await send(chatId, `⛔ Ruxsat yo'q. Chat ID: <code>${chatId}</code>`);
        continue;
      }
      const handler = commands[cmd] || commands.help;
      try {
        const reply = await handler(chatId, send);
        if (reply) await send(chatId, reply);
      } catch (e) {
        await send(chatId, `❌ Xato: ${e.message}`);
      }
    }
  }
}

module.exports = { start, notifyAdmins };
