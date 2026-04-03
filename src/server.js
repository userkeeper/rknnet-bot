const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

// ── НАСТРОЙКИ ────────────────────────────────────────────────────────────────
const TOKEN       = process.env.BOT_TOKEN;
const WALLET      = process.env.WALLET      || 'TNnCZrgSQwEgWKViC1eci2MxCMdsoqTWVu';
const ADMIN_ID    = parseInt(process.env.ADMIN_ID) || 7272909965;
const PORT        = process.env.PORT        || 8080;
const APP_URL     = process.env.APP_URL     || `http://localhost:${PORT}`;
const BOT_USERNAME= process.env.BOT_USERNAME|| 'PKHHET_bot';
const CRYPTO_TOKEN= process.env.CRYPTO_TOKEN;
const CRYPTO_API  = 'https://pay.crypt.bot/api';
const VPN_API     = process.env.VPN_API     || 'http://46.62.155.188:8888';
const VPN_SECRET  = process.env.VPN_SECRET  || 'rknnet2026secret';

// ── ТАРИФЫ ───────────────────────────────────────────────────────────────────
const PLANS = {
  month1:  { label: '1 месяц',   months: 1,  price: 1,  price_fee: '1.03' },
  month6:  { label: '6 месяцев', months: 6,  price: 6,  price_fee: '6.18' },
  month12: { label: '1 год',     months: 12, price: 12, price_fee: '12.36' },
};

// ── POSTGRESQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id SERIAL PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      username TEXT,
      tx_hash TEXT,
      ref_code TEXT,
      my_ref_code TEXT,
      free_months INTEGER DEFAULT 0,
      plan TEXT DEFAULT 'month12',
      paid_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP,
      active BOOLEAN DEFAULT TRUE,
      sub_url TEXT
    )
  `).catch(e => console.error('subscribers:', e.message));
  await pool.query(`CREATE TABLE IF NOT EXISTS used_hashes (hash TEXT PRIMARY KEY)`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      plan TEXT NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  for (const sql of [
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'month12'`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS sub_url TEXT`,
  ]) await pool.query(sql).catch(() => {});
  console.log('БД готова');
}

function calcExpiry(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d;
}

async function isPaid(userId) {
  try {
    const r = await pool.query(
      `SELECT 1 FROM subscribers WHERE user_id=$1 AND active=TRUE AND (expires_at IS NULL OR expires_at > NOW())`,
      [String(userId)]
    );
    return r.rows.length > 0;
  } catch(e) { return false; }
}

async function isHashUsed(hash) {
  try {
    const r = await pool.query('SELECT 1 FROM used_hashes WHERE hash=$1', [hash]);
    return r.rows.length > 0;
  } catch(e) { return false; }
}

async function addSubscriber(userId, username, hash, planId, refCode, subUrl) {
  const myCode = `RKN${String(userId).slice(-5)}`;
  const plan = PLANS[planId] || PLANS.month12;
  const expiresAt = calcExpiry(plan.months);
  await pool.query(`
    INSERT INTO subscribers (user_id, username, tx_hash, ref_code, my_ref_code, plan, expires_at, sub_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id) DO UPDATE SET
      active=TRUE, plan=$6, expires_at=$7,
      sub_url=COALESCE($8, subscribers.sub_url),
      username=COALESCE($2, subscribers.username)
  `, [String(userId), username || String(userId), hash || null, refCode || null, myCode, planId || 'month12', expiresAt, subUrl || null])
    .catch(e => console.error('addSubscriber:', e.message));
  if (hash) await pool.query(`INSERT INTO used_hashes VALUES ($1) ON CONFLICT DO NOTHING`, [hash]).catch(() => {});
  if (refCode) await pool.query(`UPDATE subscribers SET free_months=free_months+1 WHERE my_ref_code=$1`, [refCode]).catch(() => {});
}

async function totalSubscribers() {
  try {
    const r = await pool.query('SELECT COUNT(*) FROM subscribers WHERE active=TRUE');
    return parseInt(r.rows[0].count) || 0;
  } catch(e) { return 0; }
}

async function getUserData(userId) {
  try {
    const uid = String(userId);
    const myCode = `RKN${uid.slice(-5)}`;
    const [sub, refs, total] = await Promise.all([
      pool.query('SELECT * FROM subscribers WHERE user_id=$1', [uid]),
      pool.query('SELECT COUNT(*) FROM subscribers WHERE ref_code=$1', [myCode]),
      totalSubscribers()
    ]);
    const row = sub.rows[0];
    const paid = row && row.active && (!row.expires_at || new Date(row.expires_at) > new Date());
    return { paid, refs: parseInt(refs.rows[0].count) || 0, free: row?.free_months || 0,
      total, refCode: myCode, plan: row?.plan || null, expires_at: row?.expires_at || null, sub_url: row?.sub_url || null };
  } catch(e) {
    return { paid: false, refs: 0, free: 0, total: 0, refCode: `RKN${String(userId).slice(-5)}` };
  }
}

// ── ПРОМОКОДЫ ─────────────────────────────────────────────────────────────────
function generateCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function createPromo(planId) {
  const code = generateCode();
  await pool.query(`INSERT INTO promo_codes (code, plan) VALUES ($1, $2)`, [code, planId]);
  return code;
}

async function usePromo(code) {
  const r = await pool.query(`SELECT * FROM promo_codes WHERE code=UPPER($1) AND used=FALSE`, [code]);
  if (!r.rows[0]) return null;
  await pool.query(`UPDATE promo_codes SET used=TRUE WHERE code=UPPER($1)`, [code]);
  return r.rows[0];
}

async function listPromos() {
  const r = await pool.query(`SELECT * FROM promo_codes WHERE used=FALSE ORDER BY created_at DESC LIMIT 30`);
  return r.rows;
}

// ── VPN + QR ──────────────────────────────────────────────────────────────────
async function provisionVPN(userId) {
  try {
    const r = await axios.get(`${VPN_API}/add`, { params: { secret: VPN_SECRET, uid: String(userId) }, timeout: 10000 });
    if (r.data.ok) return r.data.sub_url;
    return null;
  } catch(e) { console.error('VPN:', e.message); return null; }
}

function escMd(s) {
  return String(s).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, c => '\\' + c);
}

async function sendVPNConfig(userId, planLabel) {
  const subUrl = await provisionVPN(userId);
  const url = subUrl || `${VPN_API}/sub?id=${userId}`;
  if (subUrl) await pool.query('UPDATE subscribers SET sub_url=$1 WHERE user_id=$2', [subUrl, String(userId)]).catch(() => {});

  const qrBuf = await QRCode.toBuffer(url, { type: 'png', width: 400, margin: 2 });
  const caption =
    `🎉 *РКН\\.НЕТ* — тариф *${escMd(planLabel)}*\n\n` +
    `📱 *Как подключиться:*\n` +
    `1\\. Скачай Streisand \\(iPhone\\) или v2rayNG \\(Android\\)\n` +
    `2\\. Нажми \\+ → Import from URL\n` +
    `3\\. Отсканируй QR ниже\n\n` +
    `🔗 \`${escMd(url)}\``;

  await bot.sendPhoto(userId, qrBuf, { caption, parse_mode: 'MarkdownV2' }).catch(async () => {
    await bot.sendMessage(userId, caption, { parse_mode: 'MarkdownV2' });
  });

  await bot.sendPhoto(ADMIN_ID, qrBuf, {
    caption: `📋 Дубль для ${userId} | ${planLabel}\n${url}`
  }).catch(() => {});
}

// ── TRON ──────────────────────────────────────────────────────────────────────
async function verifyTronTx(hash, expectedAmount) {
  try {
    const { data } = await axios.get(`https://api.trongrid.io/v1/transactions/${hash}`,
      { timeout: 10000, headers: { Accept: 'application/json' } });
    if (!data.data?.length) return { ok: false, status: 'not_found', amount: 0 };
    const tx = data.data[0];
    if (tx.ret?.[0]?.contractRet !== 'SUCCESS') return { ok: false, status: 'not_confirmed', amount: 0 };
    const value = tx.raw_data?.contract?.[0]?.parameter?.value || {};
    const amount = (value.amount || 0) / 1_000_000;
    if (amount < (expectedAmount || 0.99) * 0.99) return { ok: false, status: 'wrong_amount', amount };
    return { ok: true, status: 'ok', amount };
  } catch(e) { return { ok: false, status: 'error', amount: 0 }; }
}

// ── CRYPTOBOT ─────────────────────────────────────────────────────────────────
async function createInvoice(userId, planId, refCode) {
  try {
    const plan = PLANS[planId];
    if (!plan) return null;
    const r = await axios.post(`${CRYPTO_API}/createInvoice`, {
      asset: 'USDT',
      amount: String(plan.price_fee),
      description: `РКН.НЕТ — ${plan.label}`,
      payload: JSON.stringify({ userId, planId, refCode }),
      allow_comments: false, allow_anonymous: false, expires_in: 3600
    }, { headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } });
    if (r.data.ok) return r.data.result;
    return null;
  } catch(e) { return null; }
}

async function checkInvoice(invoiceId) {
  try {
    const r = await axios.get(`${CRYPTO_API}/getInvoices`,
      { params: { invoice_ids: invoiceId }, headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } });
    if (r.data.ok && r.data.result.items.length > 0) return r.data.result.items[0];
    return null;
  } catch(e) { return null; }
}

// ── BOT ───────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
const userRefCodes = new Map();

const mainKeyboard = (userId) => ({
  inline_keyboard: [
    [{ text: '🎁 Открыть Mini App', web_app: { url: `${APP_URL}/app.html?uid=${userId}` } }],
    [{ text: '📱 Как подключиться', callback_data: 'howto' }, { text: '❓ FAQ', callback_data: 'faq' }],
    [{ text: '👥 Пригласи друга', callback_data: 'ref' }]
  ]
});

bot.onText(/\/start(.*)/, async (msg, match) => {
  const userId = msg.from.id;
  const param = match[1]?.trim();
  if (param?.startsWith('RKN')) userRefCodes.set(userId, param);
  const paid = await isPaid(userId);
  await bot.sendMessage(userId,
    `🛡 *РКН\\.НЕТ* — свободный интернет\n\nVLESS Reality \\+ Hysteria2\\. Не блокируется ТСПУ\\.\n\n${paid ? '✅ Подписка активна\\!' : 'Открой Mini App и выбери тариф:'}`,
    { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard(userId) }
  );
});

// Admin
bot.onText(/\/grant (\d+) (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [, targetId, planId] = match;
  if (!PLANS[planId]) return bot.sendMessage(ADMIN_ID, `❌ Тарифы: month1, month6, month12`);
  await addSubscriber(targetId, null, null, planId, null, null);
  await sendVPNConfig(targetId, PLANS[planId].label);
  bot.sendMessage(ADMIN_ID, `✅ Доступ выдан: ${targetId} — ${PLANS[planId].label}`);
});

bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const total = await totalSubscribers();
  const promos = await listPromos();
  bot.sendMessage(ADMIN_ID, `📊 Подписчиков: ${total}\n🎟 Промокодов: ${promos.length}`);
});

bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  await bot.answerCallbackQuery(q.id);
  const back = { inline_keyboard: [[{ text: '← Назад', callback_data: 'main' }]] };
  const edit = (text, kb) => bot.editMessageText(text, {
    chat_id: q.message.chat.id, message_id: q.message.message_id,
    parse_mode: 'MarkdownV2', reply_markup: kb
  });

  if (q.data === 'main') {
    await edit(`🛡 *РКН\\.НЕТ*`, mainKeyboard(userId));
  } else if (q.data === 'howto') {
    await edit(`📱 *Как подключиться*\n\n1\\. Скачай Streisand \\(iPhone\\) или v2rayNG \\(Android\\)\n2\\. Оплати в Mini App\n3\\. Получи QR в боте → отсканируй\n4\\. Нажми подключить ✓`, back);
  } else if (q.data === 'faq') {
    await edit(`❓ *FAQ*\n\n*Законно?* Да\\.\n*Устройств?* До 5\\.\n*Возврат?* 3 дня\\.`, back);
  } else if (q.data === 'ref') {
    const code = `RKN${String(userId).slice(-5)}`;
    const data = await getUserData(userId);
    await edit(`👥 *Реферальная программа*\n\nЗа каждого оплатившего — *\\+1 месяц бесплатно*\n\nТвоя ссылка:\n\`https://t\\.me/${BOT_USERNAME}?start=${code}\`\n\nПриглашено: *${data.refs}*`, back);
  } else if (q.data.startsWith('check_')) {
    const invoiceId = q.data.replace('check_', '');
    const invoice = await checkInvoice(invoiceId);
    if (!invoice || invoice.status !== 'paid') {
      await bot.sendMessage(userId, `⏳ Оплата не найдена\\. Попробуй через минуту\\.`, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Проверить', callback_data: `check_${invoiceId}` }]] }
      });
      return;
    }
    if (await isPaid(userId)) { await bot.sendMessage(userId, '✅ Уже активна\\!', { parse_mode: 'MarkdownV2' }); return; }
    let payload = {};
    try { payload = JSON.parse(invoice.payload || '{}'); } catch(e) {}
    const planId = payload.planId || 'month12';
    const plan = PLANS[planId] || PLANS.month12;
    await addSubscriber(userId, q.from.username, `cryptobot_${invoiceId}`, planId, payload.refCode || userRefCodes.get(userId), null);
    await sendVPNConfig(userId, plan.label);
    const total = await totalSubscribers();
    await bot.sendMessage(ADMIN_ID, `💰 CryptoBot\n👤 @${q.from.username || userId}\n📦 ${plan.label}\n📊 ${total}`).catch(() => {});
  }
});

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/plans', (req, res) => {
  res.json(Object.entries(PLANS).map(([id, p]) => ({ id, ...p })));
});

app.post('/api/create-invoice', async (req, res) => {
  const { userId, planId, refCode } = req.body;
  if (!userId || !planId) return res.json({ ok: false });
  const invoice = await createInvoice(userId, planId, refCode);
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
  const planId = payload.planId || 'month12';
  const plan = PLANS[planId] || PLANS.month12;
  await addSubscriber(userId, String(userId), `cryptobot_${invoiceId}`, planId, payload.refCode || null, null);
  await sendVPNConfig(userId, plan.label).catch(() => {});
  const total = await totalSubscribers();
  await bot.sendMessage(ADMIN_ID, `💰 Mini App\n🆔 ${userId}\n📦 ${plan.label}\n📊 ${total}`).catch(() => {});
  res.json({ paid: true });
});

app.post('/api/verify', async (req, res) => {
  const { hash, userId, planId, refCode } = req.body;
  if (!hash || !userId) return res.json({ ok: false, status: 'missing_params' });
  if (await isPaid(userId)) return res.json({ ok: false, status: 'already_paid' });
  if (await isHashUsed(hash)) return res.json({ ok: false, status: 'hash_used' });
  if (hash.length < 60) return res.json({ ok: false, status: 'invalid_hash' });
  const plan = PLANS[planId] || PLANS.month12;
  const result = await verifyTronTx(hash, plan.price);
  if (result.ok) {
    await addSubscriber(userId, String(userId), hash, planId, refCode || null, null);
    await sendVPNConfig(userId, plan.label).catch(() => {});
    const total = await totalSubscribers();
    await bot.sendMessage(ADMIN_ID, `💰 USDT\n🆔 ${userId}\n💵 ${result.amount.toFixed(2)}\n📦 ${plan.label}\n📊 ${total}`).catch(() => {});
    return res.json({ ok: true });
  }
  res.json(result);
});

app.post('/api/promo/use', async (req, res) => {
  const { code, userId, refCode } = req.body;
  if (!code || !userId) return res.json({ ok: false, msg: 'Нет кода' });
  if (await isPaid(userId)) return res.json({ ok: false, msg: 'Уже активна' });
  const promo = await usePromo(code);
  if (!promo) return res.json({ ok: false, msg: 'Промокод не найден или использован' });
  const plan = PLANS[promo.plan] || PLANS.month1;
  await addSubscriber(userId, String(userId), `promo_${code}_${Date.now()}`, promo.plan, refCode || null, null);
  await sendVPNConfig(userId, plan.label).catch(() => {});
  await bot.sendMessage(ADMIN_ID, `🎟 Промокод ${code}\n🆔 ${userId}\n📦 ${plan.label}`).catch(() => {});
  res.json({ ok: true, label: plan.label });
});

app.get('/api/user/:userId', async (req, res) => {
  res.json(await getUserData(req.params.userId));
});

app.get('/api/qr/:userId', async (req, res) => {
  try {
    const data = await getUserData(req.params.userId);
    const url = data.sub_url || `${VPN_API}/sub?id=${req.params.userId}`;
    const buf = await QRCode.toBuffer(url, { type: 'png', width: 400, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch(e) { res.status(500).end(); }
});

// Admin API
app.post('/api/admin/grant', async (req, res) => {
  const { adminId, targetUserId, planId } = req.body;
  if (parseInt(adminId) !== ADMIN_ID) return res.json({ ok: false });
  if (!PLANS[planId]) return res.json({ ok: false, msg: 'Нет тарифа' });
  await addSubscriber(targetUserId, null, null, planId, null, null);
  await sendVPNConfig(targetUserId, PLANS[planId].label).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/admin/promo/create', async (req, res) => {
  const { adminId, planId } = req.body;
  if (parseInt(adminId) !== ADMIN_ID) return res.json({ ok: false });
  if (!PLANS[planId]) return res.json({ ok: false, msg: 'Нет тарифа' });
  const code = await createPromo(planId);
  res.json({ ok: true, code, label: PLANS[planId].label });
});

app.get('/api/admin/promos', async (req, res) => {
  const { adminId } = req.query;
  if (parseInt(adminId) !== ADMIN_ID) return res.json({ ok: false });
  res.json({ ok: true, promos: await listPromos() });
});

app.get('/api/admin/stats', async (req, res) => {
  const { adminId } = req.query;
  if (parseInt(adminId) !== ADMIN_ID) return res.json({ ok: false });
  const total = await totalSubscribers();
  const all_users = await pool.query(
    `SELECT user_id, username, plan, expires_at, active, paid_at
     FROM subscribers ORDER BY paid_at DESC LIMIT 100`
  ).catch(() => ({ rows: [] }));
  res.json({ ok: true, total, all_users: all_users.rows });
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`РКН.НЕТ на порту ${PORT}`));
});
