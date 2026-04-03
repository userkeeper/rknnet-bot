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
const VPN_API = process.env.VPN_API || 'http://46.62.155.188:8888';
const VPN_SECRET = process.env.VPN_SECRET || 'rknnet2026secret';

// ── ТАРИФЫ ────────────────────────────────────────────────────────────────
const PLANS = {
  month1:  { label: '1 месяц',   months: 1,  price: 3,  price_fee: (3  * 1.03).toFixed(2) },
  month6:  { label: '6 месяцев', months: 6,  price: 15, price_fee: (15 * 1.03).toFixed(2) },
  month12: { label: '1 год',     months: 12, price: 24, price_fee: (24 * 1.03).toFixed(2) },
};

// ── CRYPTOBOT API ──────────────────────────────────────────────────────────
async function createInvoice(userId, planId, promoCode = null, refCode = null) {
  try {
    const plan = PLANS[planId];
    if (!plan) return null;
    let finalPrice = parseFloat(plan.price_fee);
    let discountPct = 0;
    if (promoCode) {
      const promo = await getPromo(promoCode);
      if (promo) {
        discountPct = promo.discount;
        finalPrice = parseFloat((plan.price * (1 - discountPct / 100) * 1.03).toFixed(2));
      }
    }
    const payload = JSON.stringify({ userId, planId, promoCode, discountPct, refCode });
    const r = await axios.post(`${CRYPTO_API}/createInvoice`, {
      asset: 'USDT',
      amount: String(Math.max(finalPrice, 0.01)),
      description: `РКН.НЕТ — ${plan.label}${discountPct ? ` (скидка ${discountPct}%)` : ''}`,
      payload,
      allow_comments: false,
      allow_anonymous: false,
      expires_in: 3600
    }, { headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } });
    if (r.data.ok) return { ...r.data.result, finalPrice };
    return null;
  } catch(e) { console.error('CryptoBot error:', e.message); return null; }
}

async function checkInvoice(invoiceId) {
  try {
    const r = await axios.get(`${CRYPTO_API}/getInvoices`, {
      params: { invoice_ids: invoiceId },
      headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
    });
    if (r.data.ok && r.data.result.items.length > 0) return r.data.result.items[0];
    return null;
  } catch(e) { return null; }
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
    `);
    await pool.query(`CREATE TABLE IF NOT EXISTS used_hashes (hash TEXT PRIMARY KEY)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        discount INTEGER NOT NULL DEFAULT 0,
        free_plan TEXT,
        max_uses INTEGER DEFAULT 1,
        uses INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // migrate existing columns
    for (const col of [
      `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`,
      `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'month12'`,
      `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS sub_url TEXT`,
    ]) await pool.query(col).catch(()=>{});
    console.log('БД инициализирована');
  } catch(e) { console.error('Ошибка БД:', e.message); }
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

async function addSubscriber(userId, username, hash, planId = 'month12', refCode = null, subUrl = null) {
  const myCode = `RKN${String(userId).slice(-5)}`;
  const plan = PLANS[planId] || PLANS.month12;
  const expiresAt = calcExpiry(plan.months);
  try {
    await pool.query(`
      INSERT INTO subscribers (user_id, username, tx_hash, ref_code, my_ref_code, plan, expires_at, sub_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (user_id) DO UPDATE SET
        active=TRUE, plan=$6, expires_at=$7,
        sub_url=COALESCE($8, subscribers.sub_url),
        username=COALESCE($2, subscribers.username)
    `, [String(userId), username, hash || null, refCode, myCode, planId, expiresAt, subUrl]);
    if (hash) await pool.query(`INSERT INTO used_hashes VALUES ($1) ON CONFLICT DO NOTHING`, [hash]);
    if (refCode) await pool.query(`UPDATE subscribers SET free_months=free_months+1 WHERE my_ref_code=$1`, [refCode]);
  } catch(e) { console.error('addSubscriber error:', e.message); }
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
    const sub = await pool.query('SELECT * FROM subscribers WHERE user_id=$1', [uid]);
    const refs = await pool.query('SELECT COUNT(*) FROM subscribers WHERE ref_code=$1', [myCode]);
    const total = await totalSubscribers();
    const row = sub.rows[0];
    const paid = row && row.active && (!row.expires_at || new Date(row.expires_at) > new Date());
    return {
      paid,
      refs: parseInt(refs.rows[0].count) || 0,
      free: row?.free_months || 0,
      total,
      refCode: myCode,
      plan: row?.plan || null,
      expires_at: row?.expires_at || null,
      sub_url: row?.sub_url || null
    };
  } catch(e) { return { paid: false, refs: 0, free: 0, total: 0, refCode: `RKN${String(userId).slice(-5)}` }; }
}

// ── ПРОМОКОДЫ ─────────────────────────────────────────────────────────────
async function getPromo(code) {
  try {
    const r = await pool.query(
      `SELECT * FROM promo_codes WHERE code=UPPER($1) AND active=TRUE AND (max_uses=0 OR uses < max_uses)`,
      [code]
    );
    return r.rows[0] || null;
  } catch(e) { return null; }
}

async function usePromo(code) {
  try { await pool.query('UPDATE promo_codes SET uses=uses+1 WHERE code=UPPER($1)', [code]); } catch(e) {}
}

async function createPromo(code, discount, freePlan, maxUses) {
  try {
    await pool.query(
      `INSERT INTO promo_codes (code, discount, free_plan, max_uses) VALUES (UPPER($1),$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET discount=$2, free_plan=$3, max_uses=$4, active=TRUE, uses=0`,
      [code, discount || 0, freePlan || null, maxUses || 1]
    );
    return true;
  } catch(e) { return false; }
}

async function listPromos() {
  try {
    const r = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 30');
    return r.rows;
  } catch(e) { return []; }
}

// ── VPN ────────────────────────────────────────────────────────────────────
async function provisionVPN(userId) {
  try {
    const r = await axios.get(`${VPN_API}/add`, {
      params: { secret: VPN_SECRET, uid: String(userId) },
      timeout: 10000
    });
    if (r.data.ok) return r.data.sub_url;
    return null;
  } catch(e) { console.error('VPN provision error:', e.message); return null; }
}

async function sendVPNConfig(userId, planLabel) {
  const subUrl = await provisionVPN(userId);
  if (subUrl) {
    await pool.query('UPDATE subscribers SET sub_url=$1 WHERE user_id=$2', [subUrl, String(userId)]).catch(()=>{});
  }
  const url = subUrl;
  const esc = s => s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, c => '\\'+c);
  await bot.sendMessage(userId,
    `🎉 *Твой VPN готов\\!*\nТариф: *${esc(planLabel)}*\n\n` +
    `📱 *Шаг 1:* Скачай приложение\n— iPhone: Streisand\n— Android: v2rayNG\n\n` +
    `📡 *Шаг 2:* \\+ → Import from URL → вставь ссылку\n\n` +
    (url ? `🔗 *Ссылка подписки:*\n\`${esc(url)}\`` : `_Конфиг будет отправлен в течение часа_`),
    { parse_mode: 'MarkdownV2', disable_web_page_preview: true }
  );
  if (url) {
    await bot.sendMessage(userId, `Быстрое подключение:`, {
      reply_markup: { inline_keyboard: [[{ text: '🔗 Открыть ссылку подписки', url }]] }
    });
  }
}

// ── TRON ───────────────────────────────────────────────────────────────────
async function verifyTronTx(hash, expectedAmount) {
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
    const minAmount = expectedAmount ? expectedAmount * 0.99 : 2.9;
    if (amount < minAmount) return { ok: false, status: 'wrong_amount', amount };
    return { ok: true, status: 'ok', amount };
  } catch(e) { return { ok: false, status: 'error', amount: 0 }; }
}

// ── BOT ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
const waitingHash = new Map();
const userRefCodes = new Map();

function mainKeyboard(userId) {
  return {
    inline_keyboard: [
      [{ text: '🎁 Открыть Mini App', web_app: { url: `${APP_URL}/app.html?uid=${userId}` } }],
      [{ text: '📱 Как подключиться', callback_data: 'howto' }, { text: '❓ FAQ', callback_data: 'faq' }],
      [{ text: '👥 Пригласи друга', callback_data: 'ref' }]
    ]
  };
}

bot.onText(/\/start(.*)/, async (msg, match) => {
  const userId = msg.from.id;
  const param = match[1]?.trim() || null;
  if (param?.startsWith('RKN')) userRefCodes.set(userId, param);
  const paid = await isPaid(userId);
  await bot.sendMessage(userId,
    `🛡 *РКН\\.НЕТ* — свободный интернет\n\nVLESS Reality \\+ Hysteria2\\. Не блокируется ТСПУ\\.\n\n${paid ? '✅ Подписка активна\\!' : 'Открой Mini App и выбери тариф:'}`,
    { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard(userId) }
  );
});

// Admin команды
bot.onText(/\/grant (\d+) (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [, targetId, planId] = match;
  if (!PLANS[planId]) return bot.sendMessage(ADMIN_ID, `❌ Тарифы: month1, month6, month12`);
  await addSubscriber(targetId, 'admin_grant', null, planId);
  await sendVPNConfig(targetId, PLANS[planId].label);
  bot.sendMessage(ADMIN_ID, `✅ Доступ выдан: ${targetId} — ${PLANS[planId].label}`);
});

bot.onText(/\/promo (.+) (\d+)% (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  await createPromo(match[1], parseInt(match[2]), null, parseInt(match[3]));
  bot.sendMessage(ADMIN_ID, `✅ Промокод: ${match[1].toUpperCase()}\nСкидка: ${match[2]}%\nИспользований: ${match[3]}`);
});

bot.onText(/\/freepromo (.+) (\w+) (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  if (!PLANS[match[2]]) return bot.sendMessage(ADMIN_ID, `❌ Тарифы: month1, month6, month12`);
  await createPromo(match[1], 100, match[2], parseInt(match[3]));
  bot.sendMessage(ADMIN_ID, `✅ Бесплатный промокод: ${match[1].toUpperCase()}\nТариф: ${PLANS[match[2]].label}\nИспользований: ${match[3]}`);
});

bot.onText(/\/promos/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const promos = await listPromos();
  if (!promos.length) return bot.sendMessage(ADMIN_ID, 'Промокодов нет');
  bot.sendMessage(ADMIN_ID, promos.map(p =>
    `${p.code} | ${p.discount}%${p.free_plan ? ` [${p.free_plan}]` : ''} | ${p.uses}/${p.max_uses} | ${p.active ? '✅' : '❌'}`
  ).join('\n'));
});

bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const total = await totalSubscribers();
  bot.sendMessage(ADMIN_ID, `📊 Активных подписчиков: ${total}`);
});

bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  await bot.answerCallbackQuery(q.id);
  const edit = (text, kb) => bot.editMessageText(text, {
    chat_id: q.message.chat.id, message_id: q.message.message_id,
    parse_mode: 'MarkdownV2', reply_markup: kb
  });
  const back = { inline_keyboard: [[{ text: '← Назад', callback_data: 'main' }]] };

  if (q.data === 'main') {
    await edit(`🛡 *РКН\\.НЕТ*`, mainKeyboard(userId));
  } else if (q.data === 'howto') {
    await edit(`📱 *Как подключиться*\n\n1\\. Скачай Streisand \\(iPhone\\) или v2rayNG \\(Android\\)\n2\\. Открой Mini App → выбери тариф → оплати\n3\\. Получи ссылку в боте → вставь в приложение\n4\\. Нажми подключить ✓`, back);
  } else if (q.data === 'faq') {
    await edit(`❓ *FAQ*\n\n*Законно?* Да, для пользователей не запрещено\\.\n*Устройств?* До 5 одновременно\\.\n*Возврат?* 3 дня на тест после подключения\\.`, back);
  } else if (q.data === 'ref') {
    const code = `RKN${String(userId).slice(-5)}`;
    const data = await getUserData(userId);
    await edit(`👥 *Реферальная программа*\n\nЗа каждого оплатившего друга — *\\+1 месяц бесплатно*\n\nТвоя ссылка:\n\`https://t\\.me/${BOT_USERNAME}?start=${code}\`\n\nПриглашено: *${data.refs}*\nБесплатных месяцев: *${data.free}*`, back);
  } else if (q.data.startsWith('check_')) {
    const invoiceId = q.data.replace('check_', '');
    const invoice = await checkInvoice(invoiceId);
    if (!invoice || invoice.status !== 'paid') {
      await bot.sendMessage(userId, `⏳ Оплата ещё не получена\\. Попробуй через минуту\\.`, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Проверить', callback_data: `check_${invoiceId}` }]] }
      });
      return;
    }
    if (await isPaid(userId)) { await bot.sendMessage(userId, '✅ Подписка уже активна\\!', { parse_mode: 'MarkdownV2' }); return; }
    let payload = {};
    try { payload = JSON.parse(invoice.payload || '{}'); } catch(e) {}
    const planId = payload.planId || 'month12';
    const plan = PLANS[planId] || PLANS.month12;
    await addSubscriber(userId, q.from.username || String(userId), `cryptobot_${invoiceId}`, planId, payload.refCode || userRefCodes.get(userId));
    if (payload.promoCode) await usePromo(payload.promoCode);
    const total = await totalSubscribers();
    await sendVPNConfig(userId, plan.label);
    try { await bot.sendMessage(ADMIN_ID, `💰 Оплата CryptoBot\n👤 @${q.from.username || userId}\n📦 ${plan.label}\n📊 Всего: ${total}`); } catch(e) {}
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;
  if (!waitingHash.has(userId)) return;
  const { planId, promoCode } = waitingHash.get(userId);
  waitingHash.delete(userId);
  if (text.length < 60) return bot.sendMessage(userId, '⚠️ Не похоже на хэш\\.', { parse_mode: 'MarkdownV2' });
  if (await isPaid(userId)) return bot.sendMessage(userId, '✅ Подписка уже активна\\!', { parse_mode: 'MarkdownV2' });
  if (await isHashUsed(text)) return bot.sendMessage(userId, '❌ Хэш уже использован\\.', { parse_mode: 'MarkdownV2' });
  const plan = PLANS[planId] || PLANS.month12;
  const wait = await bot.sendMessage(userId, '⏳ Проверяю транзакцию\\.\\.\\.', { parse_mode: 'MarkdownV2' });
  const { ok, status, amount } = await verifyTronTx(text, plan.price);
  if (!ok) {
    const msgs = { not_found: '❌ Не найдена\\. Подожди 1\\-2 мин\\.', not_confirmed: '⏳ Ещё не подтверждена\\.', wrong_amount: `❌ Сумма: *${amount?.toFixed(2)} USDT*\\. Нужно *${plan.price} USDT*\\.`, error: '⚠️ Ошибка\\.' };
    return bot.editMessageText(msgs[status] || msgs.error, { chat_id: userId, message_id: wait.message_id, parse_mode: 'MarkdownV2' });
  }
  if (promoCode) await usePromo(promoCode);
  await addSubscriber(userId, msg.from.username || String(userId), text, planId, userRefCodes.get(userId));
  const total = await totalSubscribers();
  await bot.editMessageText(`✅ *Подтверждено\\!* Настраиваю VPN\\.\\.\\.`, { chat_id: userId, message_id: wait.message_id, parse_mode: 'MarkdownV2' });
  await sendVPNConfig(userId, plan.label);
  try { await bot.sendMessage(ADMIN_ID, `💰 Оплата USDT\n👤 @${msg.from.username || userId}\n💵 ${amount.toFixed(2)} USDT\n📦 ${plan.label}\n📊 Всего: ${total}`); } catch(e) {}
});

// ── EXPRESS ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/plans', (req, res) => {
  res.json(Object.entries(PLANS).map(([id, p]) => ({ id, ...p })));
});

app.post('/api/promo/check', async (req, res) => {
  const { code, planId } = req.body;
  if (!code) return res.json({ ok: false });
  const promo = await getPromo(code);
  if (!promo) return res.json({ ok: false, msg: 'Промокод не найден или исчерпан' });
  const plan = PLANS[promo.free_plan || planId] || PLANS.month12;
  const discountedPrice = promo.discount === 100 ? 0 : parseFloat((plan.price * (1 - promo.discount / 100) * 1.03).toFixed(2));
  res.json({ ok: true, discount: promo.discount, freePlan: promo.free_plan, discountedPrice, planLabel: plan.label });
});

app.post('/api/create-invoice', async (req, res) => {
  const { userId, planId, promoCode, refCode } = req.body;
  if (!userId || !planId) return res.json({ ok: false });
  if (promoCode) {
    const promo = await getPromo(promoCode);
    if (promo && promo.discount === 100 && promo.free_plan) {
      await addSubscriber(userId, String(userId), `promo_${promoCode}_${Date.now()}`, promo.free_plan, refCode || null);
      await usePromo(promoCode);
      await sendVPNConfig(userId, PLANS[promo.free_plan].label).catch(()=>{});
      return res.json({ ok: true, free: true });
    }
  }
  const invoice = await createInvoice(userId, planId, promoCode, refCode);
  if (!invoice) return res.json({ ok: false });
  res.json({ ok: true, pay_url: invoice.pay_url, invoice_id: invoice.invoice_id, amount: invoice.finalPrice });
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
  await addSubscriber(userId, String(userId), `cryptobot_${invoiceId}`, planId, payload.refCode || null);
  if (payload.promoCode) await usePromo(payload.promoCode);
  const total = await totalSubscribers();
  try { await bot.sendMessage(ADMIN_ID, `💰 Оплата Mini App\n🆔 ${userId}\n📦 ${plan.label}\n📊 Всего: ${total}`); } catch(e) {}
  await sendVPNConfig(userId, plan.label).catch(()=>{});
  res.json({ paid: true });
});

app.post('/api/verify', async (req, res) => {
  const { hash, userId, planId, promoCode, refCode } = req.body;
  if (!hash || !userId) return res.json({ ok: false, status: 'missing_params' });
  if (await isPaid(userId)) return res.json({ ok: false, status: 'already_paid' });
  if (await isHashUsed(hash)) return res.json({ ok: false, status: 'hash_used' });
  if (hash.length < 60) return res.json({ ok: false, status: 'invalid_hash' });
  const plan = PLANS[planId] || PLANS.month12;
  const result = await verifyTronTx(hash, plan.price);
  if (result.ok) {
    if (promoCode) await usePromo(promoCode);
    await addSubscriber(userId, String(userId), hash, planId, refCode || null);
    const total = await totalSubscribers();
    try { await bot.sendMessage(ADMIN_ID, `💰 Оплата USDT (Mini App)\n🆔 ${userId}\n💵 ${result.amount.toFixed(2)} USDT\n📦 ${plan.label}\n📊 Всего: ${total}`); } catch(e) {}
    await sendVPNConfig(userId, plan.label).catch(()=>{});
    return res.json({ ...result, total });
  }
  res.json(result);
});

app.get('/api/user/:userId', async (req, res) => {
  res.json(await getUserData(req.params.userId));
});

// Admin API
app.post('/api/admin/grant', async (req, res) => {
  const { adminId, targetUserId, planId } = req.body;
  if (parseInt(adminId) !== ADMIN_ID) return res.json({ ok: false, msg: 'Нет доступа' });
  if (!PLANS[planId]) return res.json({ ok: false, msg: 'Нет тарифа' });
  await addSubscriber(targetUserId, 'admin_grant', null, planId, null);
  await sendVPNConfig(targetUserId, PLANS[planId].label).catch(()=>{});
  res.json({ ok: true });
});

app.post('/api/admin/promo', async (req, res) => {
  const { adminId, code, discount, freePlan, maxUses } = req.body;
  if (parseInt(adminId) !== ADMIN_ID) return res.json({ ok: false, msg: 'Нет доступа' });
  const ok = await createPromo(code, discount, freePlan, maxUses);
  res.json({ ok });
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
  const recent = await pool.query('SELECT user_id, username, plan, expires_at, paid_at FROM subscribers ORDER BY paid_at DESC LIMIT 10').catch(() => ({ rows: [] }));
  res.json({ ok: true, total, recent: recent.rows });
});

// ── ЗАПУСК ─────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`РКН.НЕТ запущен на порту ${PORT}`));
});
