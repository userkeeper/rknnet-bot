const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── НАСТРОЙКИ ──────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN || '8721490853:AAHb1Z29Hxn8D2_anShDlAQXoo7H9GvMVWk';
const WALLET = 'TNnCZrgSQwEgWKViC1eci2MxCMdsoqTWVu';
const ADMIN_ID = 7272909965;
const PORT = process.env.PORT || 8080;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const DB_FILE = path.join(__dirname, '../data/subscribers.json');
const PRICE = 12.0;

// ── БД ─────────────────────────────────────────────────────────────────────
function loadDB() {
  try {
    if (!fs.existsSync(path.dirname(DB_FILE))) {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    }
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {}
  return { subscribers: {}, used_hashes: [] };
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function isPaid(userId) {
  const db = loadDB();
  return !!db.subscribers[String(userId)];
}

function isHashUsed(hash) {
  const db = loadDB();
  return db.used_hashes.includes(hash);
}

function addSubscriber(userId, username, hash, refCode = null) {
  const db = loadDB();
  const uid = String(userId);
  db.subscribers[uid] = {
    username,
    tx_hash: hash,
    paid_at: new Date().toISOString(),
    ref_code: refCode,
    free_months: 0,
    active: true,
    my_ref_code: `RKN${uid.slice(-5)}`
  };
  db.used_hashes.push(hash);
  // Начисляем реферальный месяц
  if (refCode) {
    for (const [, data] of Object.entries(db.subscribers)) {
      if (data.my_ref_code === refCode) {
        data.free_months = (data.free_months || 0) + 1;
        break;
      }
    }
  }
  saveDB(db);
}

function getRefCode(userId) {
  return `RKN${String(userId).slice(-5)}`;
}

function countReferrals(userId) {
  const db = loadDB();
  const code = getRefCode(userId);
  return Object.values(db.subscribers).filter(d => d.ref_code === code).length;
}

function getFreeMonths(userId) {
  const db = loadDB();
  const uid = String(userId);
  return db.subscribers[uid]?.free_months || 0;
}

function totalSubscribers() {
  return Object.keys(loadDB().subscribers).length;
}

// ── TRON ПРОВЕРКА ──────────────────────────────────────────────────────────
async function verifyTronTx(hash) {
  try {
    const { data } = await axios.get(
      `https://api.trongrid.io/v1/transactions/${hash}`,
      { timeout: 10000, headers: { Accept: 'application/json' } }
    );
    if (!data.data || data.data.length === 0) return { ok: false, status: 'not_found', amount: 0 };
    const tx = data.data[0];
    const ret = tx.ret?.[0];
    if (ret?.contractRet !== 'SUCCESS') return { ok: false, status: 'not_confirmed', amount: 0 };
    const value = tx.raw_data?.contract?.[0]?.parameter?.value || {};
    const amount = (value.amount || 0) / 1_000_000;
    if (amount < 11.9) return { ok: false, status: 'wrong_amount', amount };
    return { ok: true, status: 'ok', amount };
  } catch (e) {
    return { ok: false, status: 'error', amount: 0 };
  }
}

// ── TELEGRAM BOT ───────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
const userRefCodes = new Map();

bot.onText(/\/start(.*)/, async (msg, match) => {
  const userId = msg.from.id;
  const refCode = match[1]?.trim() || null;
  if (refCode) userRefCodes.set(userId, refCode);

  const appUrl = `${APP_URL}/app.html?uid=${userId}${refCode ? `&ref=${refCode}` : ''}`;

  await bot.sendMessage(userId,
    'РКН сказал нельзя\\. Мы говорим — *можно\\.*',
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[
          { text: '⚡ Открыть РКН.НЕТ', web_app: { url: appUrl } }
        ]]
      }
    }
  );
});

// ── EXPRESS + MINI APP API ─────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API — проверка хэша из Mini App
app.post('/api/verify', async (req, res) => {
  const { hash, userId, refCode } = req.body;
  if (!hash || !userId) return res.json({ ok: false, status: 'missing_params' });
  if (isPaid(userId)) return res.json({ ok: false, status: 'already_paid' });
  if (isHashUsed(hash)) return res.json({ ok: false, status: 'hash_used' });
  if (hash.length < 60) return res.json({ ok: false, status: 'invalid_hash' });

  const result = await verifyTronTx(hash);

  if (result.ok) {
    const db = loadDB();
    const username = db.subscribers[String(userId)]?.username || String(userId);
    addSubscriber(userId, username, hash, refCode || null);
    const total = totalSubscribers();

    // Уведомляем бота
    try {
      await bot.sendMessage(userId,
        `🎉 *Оплата подтверждена\\!* Ты в списке РКН\\.НЕТ\\. 10 апреля получишь конфиг\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      await bot.sendMessage(ADMIN_ID,
        `💰 *Новая оплата \\(Mini App\\)\\!*\n👤 ID: ${userId}\n💵 ${result.amount.toFixed(2)} USDT\n📊 Всего: ${total}`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {}
  }

  res.json({ ...result, total: totalSubscribers() });
});

// API — данные пользователя
app.get('/api/user/:userId', (req, res) => {
  const userId = req.params.userId;
  const db = loadDB();
  const paid = !!db.subscribers[userId];
  const refs = countReferrals(userId);
  const free = getFreeMonths(userId);
  const total = totalSubscribers();
  res.json({ paid, refs, free, total, refCode: getRefCode(userId) });
});

app.listen(PORT, () => {
  console.log(`РКН.НЕТ сервер запущен на порту ${PORT}`);
  console.log(`Mini App: ${APP_URL}/app`);
});
