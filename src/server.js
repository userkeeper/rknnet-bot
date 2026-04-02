const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');

// ── НАСТРОЙКИ ──────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN;
const WALLET = process.env.WALLET || 'TNnCZrgSQwEgWKViC1eci2MxCMdsoqTWVu';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 7272909965;
const PORT = process.env.PORT || 8080;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_USERNAME = process.env.BOT_USERNAME || 'PKHHET_bot';
const CRYPTO_TOKEN = process.env.CRYPTO_TOKEN;
const CRYPTO_API = 'https://pay.crypt.bot/api';
const PRICE_USDT = 12;
const PRICE_WITH_FEE = (12 * 1.03).toFixed(2); // 12.36 USDT с учётом комиссии 3%

// ── CRYPTOBOT API ──────────────────────────────────────────────────────────
async function createInvoice(userId, refCode = null) {
  try {
    const payload = JSON.stringify({ userId, refCode });
    const r = await axios.post(`${CRYPTO_API}/createInvoice`, {
      asset: 'USDT',
      amount: String(PRICE_WITH_FEE),
      description: `РКН.НЕТ — предподписка на год (включая комиссию сервиса)`,
      payload,
      allow_comments: false,
      allow_anonymous: false,
      expires_in: 3600
    }, {
      headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
    });
    if (r.data.ok) return r.data.result;
    return null;
  } catch(e) {
    console.error('CryptoBot createInvoice error:', e.message);
    return null;
  }
}

async function checkInvoice(invoiceId) {
  try {
    const r = await axios.get(`${CRYPTO_API}/getInvoices`, {
      params: { invoice_ids: invoiceId },
      headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
    });
    if (r.data.ok && r.data.result.items.length > 0) {
      return r.data.result.items[0];
    }
    return null;
  } catch(e) {
    console.error('CryptoBot checkInvoice error:', e.message);
    return null;
  }
}

// ── POSTGRESQL ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id SERIAL PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        username TEXT,
        tx_hash TEXT UNIQUE NOT NULL,
        ref_code TEXT,
        my_ref_code TEXT,
        free_months INTEGER DEFAULT 0,
        paid_at TIMESTAMP DEFAULT NOW(),
        active BOOLEAN DEFAULT TRUE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS used_hashes (
        hash TEXT PRIMARY KEY
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        code TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        discount INTEGER DEFAULT 0,
        months INTEGER DEFAULT 0,
        max_uses INTEGER DEFAULT 1,
        uses INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_uses (
        code TEXT,
        user_id TEXT,
        used_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (code, user_id)
      )
    `);
    console.log('БД инициализирована');
  } catch (e) {
    console.error('Ошибка БД:', e.message);
  }
}

async function isPaid(userId) {
  try {
    const r = await pool.query('SELECT 1 FROM subscribers WHERE user_id=$1', [String(userId)]);
    return r.rows.length > 0;
  } catch(e) { return false; }
}

async function isHashUsed(hash) {
  try {
    const r = await pool.query('SELECT 1 FROM used_hashes WHERE hash=$1', [hash]);
    return r.rows.length > 0;
  } catch(e) { return false; }
}

async function addSubscriber(userId, username, hash, refCode = null) {
  const myCode = `RKN${String(userId).slice(-5)}`;
  try {
    await pool.query(`
      INSERT INTO subscribers (user_id, username, tx_hash, ref_code, my_ref_code)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id) DO NOTHING
    `, [String(userId), username, hash, refCode, myCode]);

    await pool.query(`INSERT INTO used_hashes VALUES ($1) ON CONFLICT DO NOTHING`, [hash]);

    // Начисляем реферальный месяц
    if (refCode) {
      await pool.query(`
        UPDATE subscribers SET free_months = free_months + 1
        WHERE my_ref_code = $1
      `, [refCode]);
    }
  } catch(e) { console.error('addSubscriber error:', e.message); }
}

async function totalSubscribers() {
  try {
    const r = await pool.query('SELECT COUNT(*) FROM subscribers');
    return parseInt(r.rows[0].count) || 0;
  } catch(e) { return 0; }
}

async function getUserData(userId) {
  try {
    const uid = String(userId);
    const myCode = `RKN${uid.slice(-5)}`;
    const sub = await pool.query('SELECT * FROM subscribers WHERE user_id=$1', [uid]);
    const refs = await pool.query('SELECT COUNT(*) FROM subscribers WHERE ref_code=$1', [myCode]);
    const total = await totalSubscribers();
    const paid = sub.rows.length > 0;
    return {
      paid,
      refs: parseInt(refs.rows[0].count) || 0,
      free: sub.rows[0]?.free_months || 0,
      total,
      refCode: myCode
    };
  } catch(e) { return { paid: false, refs: 0, free: 0, total: 0, refCode: `RKN${String(userId).slice(-5)}` }; }
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
    if (tx.ret?.[0]?.contractRet !== 'SUCCESS') return { ok: false, status: 'not_confirmed', amount: 0 };
    const value = tx.raw_data?.contract?.[0]?.parameter?.value || {};
    const amount = (value.amount || 0) / 1_000_000;
    if (amount < 11.9) return { ok: false, status: 'wrong_amount', amount };
    return { ok: true, status: 'ok', amount };
  } catch(e) { return { ok: false, status: 'error', amount: 0 }; }
}

// ── TELEGRAM BOT ───────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
const waitingHash = new Set();
const userRefCodes = new Map();

function mainKeyboard(userId) {
  return {
    inline_keyboard: [
      [{ text: '🔥 Почему лучше VPN', callback_data: 'why' }],
      [{ text: '💳 Оплатить 12 USDT через CryptoBot', callback_data: 'pay_crypto' }],
      [{ text: '🎁 Предподписка (Mini App)', web_app: { url: `${APP_URL}/app.html?uid=${userId}` } }],
      [{ text: '📱 Как подключиться', callback_data: 'howto' },
       { text: '⚡ Скорость', callback_data: 'speed' }],
      [{ text: '❓ Вопросы', callback_data: 'faq' },
       { text: '👥 Пригласи друга', callback_data: 'ref' }]
    ]
  };
}

bot.onText(/\/start(.*)/, async (msg, match) => {
  const userId = msg.from.id;
  const refCode = match[1]?.trim() || null;
  if (refCode) userRefCodes.set(userId, refCode);
  // Бот молчит — пользователь сразу видит кнопку Mini App внизу
});

bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  await bot.answerCallbackQuery(q.id);
  const edit = (text, kb) => bot.editMessageText(text, {
    chat_id: q.message.chat.id, message_id: q.message.message_id,
    parse_mode: 'MarkdownV2', reply_markup: kb
  });
  const back = { inline_keyboard: [[{ text: '← Главное меню', callback_data: 'main' }]] };

  if (q.data === 'main') {
    await edit(`👋 *РКН\\.НЕТ*\n\nРКН сказал нельзя\\. Мы говорим — *можно\\.*`, mainKeyboard(userId));
  } else if (q.data === 'why') {
    await edit(`🔥 *VLESS Reality vs VPN*\n\n❌ VPN виден ТСПУ — блокируется\\.\n✅ VLESS Reality выглядит как HTTPS — не блокируется\\.\n\nПолная скорость, стабильно 24/7\\.`,
      { inline_keyboard: [[{ text: '🎁 Предподписка', web_app: { url: `${APP_URL}/app.html?uid=${userId}` } }], [{ text: '← Назад', callback_data: 'main' }]] });
  } else if (q.data === 'howto') {
    await edit(`📱 *Подключение за 3 шага*\n\n1\\. Скачай Streisand \\(iPhone\\) или V2rayNG \\(Android\\)\n2\\. Получи конфиг в боте после оплаты\n3\\. Вставь ссылку → подключись\n\n✅ Весь интернет открыт\\.`, back);
  } else if (q.data === 'speed') {
    await edit(`⚡ *Скорость*\n\nInstagram — 98 Мбит/с\nYouTube 4K — 85 Мбит/с\nPing — 32 мс\n\nReels, сторис, видео без буферизации\\.`, back);
  } else if (q.data === 'faq') {
    await edit(`❓ *FAQ*\n\n*Законно?* Да, для пользователей не запрещено\\.\n*Чем лучше VPN?* ТСПУ не видит VLESS Reality\\.\n*Устройств?* До 5 одновременно\\.\n*Возврат?* 3 дня на тест после запуска\\.`, back);
  } else if (q.data === 'ref') {
    const code = `RKN${String(userId).slice(-5)}`;
    const link = `https://t\\.me/${BOT_USERNAME}?start=${code}`;
    const data = await getUserData(userId);
    await edit(`👥 *Реферальная программа*\n\nЗа каждого оплатившего друга — *\\+1 месяц бесплатно*\n\nТвоя ссылка:\n\`https://t.me/${BOT_USERNAME}?start=${code}\`\n\nПриглашено: *${data.refs}*\nБесплатных месяцев: *${data.free}*`, back);
  } else if (q.data === 'pay_crypto') {
    if (await isPaid(userId)) {
      await edit(`✅ Ты уже в списке\\! Конфиг придёт 10 апреля\\.`, mainKeyboard(userId));
      return;
    }
    const refCode = userRefCodes.get(userId) || null;
    await bot.answerCallbackQuery(q.id, { text: 'Создаю счёт...' });
    const invoice = await createInvoice(userId, refCode);
    if (!invoice) {
      await edit(`❌ Ошибка создания счёта\\. Попробуй снова или оплати через USDT TRC\\-20\\.`, mainKeyboard(userId));
      return;
    }
    await edit(
      `💳 *Оплата через CryptoBot*\n\nСумма: *${PRICE_WITH_FEE} USDT*\n_\\(включая комиссию сервиса 3%\\, тебе придёт ровно 12 USDT\\)_\n\nНажми кнопку ниже — откроется CryptoBot для оплаты\\.\nМожно оплатить рублями через СБП прямо внутри\\!\n\nСчёт действителен *1 час*\\.`,
      {
        inline_keyboard: [
          [{ text: '💳 Оплатить 12 USDT', url: invoice.pay_url }],
          [{ text: '✅ Я оплатил — проверить', callback_data: `check_${invoice.invoice_id}` }],
          [{ text: '← Назад', callback_data: 'main' }]
        ]
      }
    );
  } else if (q.data.startsWith('check_')) {
    const invoiceId = q.data.replace('check_', '');
    await bot.answerCallbackQuery(q.id, { text: 'Проверяю...' });
    const invoice = await checkInvoice(invoiceId);
    if (!invoice) {
      await bot.sendMessage(userId, '❌ Не удалось проверить счёт\\. Попробуй снова\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    if (invoice.status !== 'paid') {
      await bot.sendMessage(userId,
        `⏳ Оплата ещё не получена\\.\n\nСтатус: *${invoice.status}*\n\nПопробуй через минуту\\.`,
        { parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [[{ text: '🔄 Проверить снова', callback_data: `check_${invoiceId}` }]] }
        }
      );
      return;
    }
    if (await isPaid(userId)) {
      await bot.sendMessage(userId, '✅ Ты уже в списке\\!', { parse_mode: 'MarkdownV2' });
      return;
    }
    // Оплата прошла
    let payload = {};
    try { payload = JSON.parse(invoice.payload || '{}'); } catch(e) {}
    const refCode = payload.refCode || userRefCodes.get(userId) || null;
    await addSubscriber(userId, q.from.username || String(userId), `cryptobot_${invoiceId}`, refCode);
    const total = await totalSubscribers();
    await bot.sendMessage(userId,
      `🎉 *Оплата подтверждена\\!*\n\n💵 12 USDT ✓\n📅 10 апреля получишь конфиг прямо сюда в бот\\.\n\n*РКН\\.НЕТ* ждёт тебя\\!`,
      { parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: '📱 Как подключиться', callback_data: 'howto' }]] }
      }
    );
    try {
      await bot.sendMessage(ADMIN_ID,
        `💰 *ОПЛАТА CryptoBot\\!*\n\n👤 @${q.from.username || userId}\n💵 12 USDT\n📊 Всего: *${total}*`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch(e) {}
    waitingHash.add(userId);
    await edit(`🔍 Вставь хэш транзакции следующим сообщением:`,
      { inline_keyboard: [[{ text: '← Отмена', callback_data: 'main' }]] });
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;
  if (!waitingHash.has(userId)) return;
  waitingHash.delete(userId);

  if (text.length < 60) {
    return bot.sendMessage(userId, '⚠️ Не похоже на хэш\\. Попробуй снова\\.', { parse_mode: 'MarkdownV2' });
  }
  if (await isPaid(userId)) {
    return bot.sendMessage(userId, '✅ Ты уже в списке\\!', { parse_mode: 'MarkdownV2' });
  }
  if (await isHashUsed(text)) {
    return bot.sendMessage(userId, '❌ Этот хэш уже использован\\.', { parse_mode: 'MarkdownV2' });
  }

  const wait = await bot.sendMessage(userId, '⏳ Проверяю транзакцию\\.\\.\\.', { parse_mode: 'MarkdownV2' });
  const { ok, status, amount } = await verifyTronTx(text);

  if (!ok) {
    const msgs = {
      not_found: '❌ Транзакция не найдена\\. Подожди 1\\-2 минуты\\.',
      not_confirmed: '⏳ Ещё не подтверждена\\. Подожди пару минут\\.',
      wrong_amount: `❌ Сумма: *${amount?.toFixed(2)} USDT*\\. Нужно *12 USDT*\\.`,
      error: '⚠️ Ошибка соединения\\. Попробуй снова\\.',
    };
    return bot.editMessageText(msgs[status] || msgs.error, {
      chat_id: userId, message_id: wait.message_id, parse_mode: 'MarkdownV2'
    });
  }

  const username = msg.from.username || String(userId);
  const refCode = userRefCodes.get(userId) || null;
  await addSubscriber(userId, username, text, refCode);
  const total = await totalSubscribers();

  await bot.editMessageText(
    `🎉 *Транзакция подтверждена\\!*\n\nСумма: *${amount.toFixed(2)} USDT* ✓\nСеть: *TRC\\-20* ✓\n\nТы в списке *РКН\\.НЕТ*\\. 10 апреля получишь конфиг\\.`,
    { chat_id: userId, message_id: wait.message_id, parse_mode: 'MarkdownV2' }
  );

  // Уведомление в личку админу
  try {
    await bot.sendMessage(ADMIN_ID,
      `💰 *НОВАЯ ОПЛАТА\\!*\n\n👤 @${username}\n🆔 ID: ${userId}\n💵 ${amount.toFixed(2)} USDT\n🔗 Хэш: \`${text.slice(0,20)}\\.\\.\\.\`\n📊 Всего подписчиков: *${total}*`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch(e) {}
});

// ── EXPRESS ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.post('/api/promo', async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.json({ ok: false, status: 'missing_params' });
  if (await isPaid(userId)) return res.json({ ok: false, status: 'already_paid' });

  // Проверяем не использован ли промокод этим юзером
  try {
    const r = await pool.query('SELECT 1 FROM used_hashes WHERE hash=$1', [`promo_${code}_${userId}`]);
    if (r.rows.length > 0) return res.json({ ok: false, status: 'already_used' });
  } catch(e) {}

  await addSubscriber(userId, String(userId), `promo_${code}_${userId}`, null);
  const total = await totalSubscribers();

  try {
    await bot.sendMessage(ADMIN_ID,
      `🎁 *ПРОМОКОД\\!*\n👤 ID: ${userId}\n🔑 Код: ${code}\n📊 Всего: *${total}*`,
      { parse_mode: 'MarkdownV2' }
    );
    await bot.sendMessage(userId,
      `🎉 Промокод активирован\\! 10 апреля получишь конфиг\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch(e) {}

  res.json({ ok: true });
});

// API — проверка промокода
app.post('/api/promo', async (req, res) => {
  const { code, userId } = req.body;
  if (!code || !userId) return res.json({ valid: false, message: 'Ошибка запроса' });

  try {
    // Проверяем промокод
    const r = await pool.query(
      'SELECT * FROM promo_codes WHERE code=$1 AND active=true',
      [code.toUpperCase()]
    );
    if (r.rows.length === 0) return res.json({ valid: false, message: '✗ Промокод не найден' });

    const promo = r.rows[0];

    // Проверяем лимит использований
    if (promo.uses >= promo.max_uses) return res.json({ valid: false, message: '✗ Промокод уже использован' });

    // Проверяем не использовал ли этот юзер
    const used = await pool.query(
      'SELECT 1 FROM promo_uses WHERE code=$1 AND user_id=$2',
      [code.toUpperCase(), String(userId)]
    );
    if (used.rows.length > 0) return res.json({ valid: false, message: '✗ Ты уже использовал этот промокод' });

    // Применяем промокод
    await pool.query('UPDATE promo_codes SET uses=uses+1 WHERE code=$1', [code.toUpperCase()]);
    await pool.query('INSERT INTO promo_uses (code, user_id) VALUES ($1,$2)', [code.toUpperCase(), String(userId)]);

    if (promo.type === 'free') {
      // Бесплатный доступ
      if (!(await isPaid(userId))) {
        await addSubscriber(userId, String(userId), `promo_${code}_${userId}`, null);
        const total = await totalSubscribers();
        try {
          await bot.sendMessage(ADMIN_ID, `🎁 *Промокод активирован\\!*\n👤 ${userId}\n🔑 ${code}\n📊 Всего: *${total}*`, { parse_mode: 'MarkdownV2' });
          await bot.sendMessage(userId, `🎉 Промокод активирован\\! Ты в списке РКН\\.НЕТ\\.`, { parse_mode: 'MarkdownV2' });
        } catch(e) {}
      }
      return res.json({ valid: true, type: 'free' });
    } else if (promo.type === 'discount') {
      const newPrice = (12 * (1 - promo.discount / 100)).toFixed(2);
      return res.json({ valid: true, type: 'discount', discount: promo.discount, newPrice });
    } else if (promo.type === 'months') {
      return res.json({ valid: true, type: 'months', months: promo.months });
    }
  } catch(e) {
    console.error('Promo error:', e.message);
    res.json({ valid: false, message: '✗ Ошибка сервера' });
  }
});

// Команда создания промокода (только для админа)
// Использование в Telegram: /promo FREE RKN2026 (бесплатный)
// /promo DISCOUNT RKN50 50 (скидка 50%)
// /promo MONTHS RKNBONUS 3 (3 месяца бесплатно)
bot.onText(/\/promo (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const parts = match[1].split(' ');
  const type = parts[0]?.toUpperCase();
  const code = parts[1]?.toUpperCase();
  const value = parseInt(parts[2]) || 1;
  const maxUses = parseInt(parts[3]) || 1;

  if (!type || !code) {
    return bot.sendMessage(ADMIN_ID, 'Использование:\n/promo FREE КОД [макс_использований]\n/promo DISCOUNT КОД процент [макс]\n/promo MONTHS КОД месяцы [макс]');
  }

  try {
    if (type === 'FREE') {
      await pool.query('INSERT INTO promo_codes (code, type, max_uses) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET active=true, uses=0', [code, 'free', maxUses]);
    } else if (type === 'DISCOUNT') {
      await pool.query('INSERT INTO promo_codes (code, type, discount, max_uses) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET active=true, uses=0, discount=$3', [code, 'discount', value, maxUses]);
    } else if (type === 'MONTHS') {
      await pool.query('INSERT INTO promo_codes (code, type, months, max_uses) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET active=true, uses=0, months=$3', [code, 'months', value, maxUses]);
    }
    bot.sendMessage(ADMIN_ID, `✅ Промокод создан:\nКод: *${code}*\nТип: ${type}\nЗначение: ${value}\nМакс. использований: ${maxUses}`, { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(ADMIN_ID, `❌ Ошибка: ${e.message}`);
  }
});

// Admin API — создание промокода
app.post('/api/admin/promo', async (req, res) => {
  const { code, type, value, maxUses, secret } = req.body;
  if (secret !== 'PKHMEN_ADMIN_2026') return res.json({ ok: false, error: 'Unauthorized' });
  try {
    if (type === 'free') {
      await pool.query('INSERT INTO promo_codes (code, type, max_uses) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET active=true, uses=0', [code, 'free', maxUses]);
    } else if (type === 'discount') {
      await pool.query('INSERT INTO promo_codes (code, type, discount, max_uses) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET active=true, uses=0, discount=$3', [code, 'discount', value, maxUses]);
    } else if (type === 'months') {
      await pool.query('INSERT INTO promo_codes (code, type, months, max_uses) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET active=true, uses=0, months=$3', [code, 'months', value, maxUses]);
    }
    res.json({ ok: true, code });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Admin API — статистика
app.get('/api/admin/stats', async (req, res) => {
  if (req.query.secret !== 'PKHMEN_ADMIN_2026') return res.json({ ok: false });
  try {
    const total = await totalSubscribers();
    const promos = await pool.query('SELECT COUNT(*) FROM promo_codes');
    res.json({ ok: true, total, promos: parseInt(promos.rows[0].count) });
  } catch(e) {
    res.json({ ok: false });
  }
});

app.post('/api/create-invoice', async (req, res) => {
  const { userId, refCode } = req.body;
  if (!userId) return res.json({ ok: false });
  const invoice = await createInvoice(userId, refCode);
  if (!invoice) return res.json({ ok: false });
  res.json({ ok: true, pay_url: invoice.pay_url, invoice_id: invoice.invoice_id });
});

app.get('/api/check-invoice/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;
  const { userId } = req.query;
  const invoice = await checkInvoice(invoiceId);
  if (!invoice || invoice.status !== 'paid') return res.json({ paid: false });
  if (await isPaid(userId)) return res.json({ paid: true });
  let payload = {};
  try { payload = JSON.parse(invoice.payload || '{}'); } catch(e) {}
  await addSubscriber(userId, String(userId), `cryptobot_${invoiceId}`, payload.refCode || null);
  const total = await totalSubscribers();
  try {
    await bot.sendMessage(ADMIN_ID,
      `💰 *ОПЛАТА Mini App\\!*\n🆔 ${userId}\n💵 ${PRICE_WITH_FEE} USDT\n📊 Всего: *${total}*`,
      { parse_mode: 'MarkdownV2' }
    );
    await bot.sendMessage(userId,
      `🎉 Оплата подтверждена\\! 10 апреля получишь конфиг\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch(e) {}
  res.json({ paid: true });
});

app.post('/api/verify', async (req, res) => {
  const { hash, userId, refCode } = req.body;
  if (!hash || !userId) return res.json({ ok: false, status: 'missing_params' });
  if (await isPaid(userId)) return res.json({ ok: false, status: 'already_paid' });
  if (await isHashUsed(hash)) return res.json({ ok: false, status: 'hash_used' });
  if (hash.length < 60) return res.json({ ok: false, status: 'invalid_hash' });

  const result = await verifyTronTx(hash);
  if (result.ok) {
    await addSubscriber(userId, String(userId), hash, refCode || null);
    const total = await totalSubscribers();
    try {
      await bot.sendMessage(ADMIN_ID,
        `💰 *ОПЛАТА \\(Mini App\\)\\!*\n\n🆔 ID: ${userId}\n💵 ${result.amount.toFixed(2)} USDT\n📊 Всего: *${total}*`,
        { parse_mode: 'MarkdownV2' }
      );
      await bot.sendMessage(userId,
        `🎉 *Оплата подтверждена\\!* Ты в списке РКН\\.НЕТ\\. 10 апреля получишь конфиг\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch(e) {}
    return res.json({ ...result, total });
  }
  res.json(result);
});

app.get('/api/user/:userId', async (req, res) => {
  const data = await getUserData(req.params.userId);
  res.json(data);
});

// ── ЗАПУСК ─────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`РКН.НЕТ сервер запущен на порту ${PORT}`);
    console.log(`Mini App: ${APP_URL}/app.html`);
  });
});
