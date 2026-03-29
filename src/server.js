const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── НАСТРОЙКИ ──────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN || '8721490853:AAHb1Z29Hxn8D2_anShDlAQXoo7H9GvMVWk';
const WALLET = 'TNnCZrgSQwEgWKViC1eci2MxCMdsoqTWVu';
const ADMIN_ID = 7272909965;
const PORT = process.env.PORT || 3000;
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
const waitingHash = new Set();
const userRefCodes = new Map();

function mainKeyboard(userId) {
  return {
    inline_keyboard: [
      [{ text: '🔥 Почему лучше VPN', callback_data: 'why' }],
      [{ text: '🎁 Предподписка 12 USDT/год', web_app: { url: `${APP_URL}/app?screen=promo&uid=${userId}` } }],
      [{ text: '📱 Как подключиться', callback_data: 'howto' },
       { text: '⚡ Скорость', callback_data: 'speed' }],
      [{ text: '❓ Вопросы', callback_data: 'faq' },
       { text: '👥 Пригласи друга', callback_data: 'ref' }]
    ]
  };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: '← Главное меню', callback_data: 'main' }]] };
}

bot.onText(/\/start(.*)/, async (msg, match) => {
  const userId = msg.from.id;
  const refCode = match[1]?.trim() || null;
  if (refCode) userRefCodes.set(userId, refCode);

  await bot.sendMessage(userId,
    `👋 Привет\\! Я — бот *РКН\\.НЕТ*\n\nРКН сказал нельзя\\. Мы говорим — *можно\\.*\n\nПока все VPN блокируют — мы работаем\\.\nПока другие тормозят — у нас летает\\.`,
    { parse_mode: 'MarkdownV2', reply_markup: mainKeyboard(userId) }
  );
});

bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  const action = q.data;
  await bot.answerCallbackQuery(q.id);

  const edit = (text, kb, opts = {}) =>
    bot.editMessageText(text, {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      parse_mode: 'MarkdownV2',
      reply_markup: kb,
      ...opts
    });

  if (action === 'main') {
    await edit(
      `👋 Привет\\! Я — бот *РКН\\.НЕТ*\n\nРКН сказал нельзя\\. Мы говорим — *можно\\.*\n\nПока все VPN блокируют — мы работаем\\.\nПока другие тормозят — у нас летает\\.`,
      mainKeyboard(userId)
    );
  }

  else if (action === 'why') {
    await edit(
      `🔥 *VLESS Reality vs обычный VPN*\n\n❌ *Обычный VPN:*\n● Виден как VPN трафик\n● Блокируется ТСПУ\n● Тормозит видео\n● Постоянно отваливается\n\n✅ *VLESS Reality:*\n● Выглядит как обычный HTTPS\n● Не блокируется ни одним DPI\n● Полная скорость без потерь\n● Стабильно 24/7\n\nТвой трафик маскируется под обычный сайт\\. Роскомнадзор видит HTTPS и пропускает\\.`,
      { inline_keyboard: [
        [{ text: '🎁 Хочу предподписку', web_app: { url: `${APP_URL}/app?screen=promo&uid=${userId}` } }],
        [{ text: '← Назад', callback_data: 'main' }]
      ]}
    );
  }

  else if (action === 'howto') {
    await edit(
      `📱 *Как подключиться — 3 шага*\n\n*1\\.* Скачай приложение:\n● iPhone → *Streisand* \\(App Store\\)\n● Android → *V2rayNG* \\(Play Market\\)\n● Windows → *V2rayN*\n\n*2\\.* Получи свой конфиг в этом боте после оплаты\n\n*3\\.* Скопируй ссылку → вставь → нажми «Подключить»\n\n✅ Всё\\. Весь интернет открыт\\.`,
      backKeyboard()
    );
  }

  else if (action === 'speed') {
    await edit(
      `⚡ *Скорость нашего сервиса*\n\nНаши серверы работают на канале 10 Гбит/с:\n\n📊 Instagram — *98 Мбит/с*\n📊 YouTube 4K — *85 Мбит/с*\n📊 Reels / TikTok — *95 Мбит/с*\n📊 Ping — *32 мс*\n\nReels, сторис, видео — всё без буферизации\\.`,
      { inline_keyboard: [
        [{ text: '🎁 Хочу предподписку', web_app: { url: `${APP_URL}/app?screen=promo&uid=${userId}` } }],
        [{ text: '← Назад', callback_data: 'main' }]
      ]}
    );
  }

  else if (action === 'faq') {
    await edit(
      `❓ *Частые вопросы*\n\n*Это законно?*\nИспользование VPN в России не запрещено для пользователей\\.\n\n*Чем отличается от VPN?*\nVLESS Reality маскируется под HTTPS — ТСПУ не блокирует\\.\n\n*Сколько устройств?*\nДо 5 одновременно: телефон, планшет, ноутбук, ПК, роутер\\.\n\n*Что если не понравится?*\nПосле запуска 3 дня на тест\\. Возвращаем деньги\\.`,
      { inline_keyboard: [
        [{ text: '🎁 Хочу предподписку', web_app: { url: `${APP_URL}/app?screen=promo&uid=${userId}` } }],
        [{ text: '← Назад', callback_data: 'main' }]
      ]}
    );
  }

  else if (action === 'ref') {
    const code = getRefCode(userId);
    const refs = countReferrals(userId);
    const free = getFreeMonths(userId);
    const link = `https://t.me/rkn_net_bot?start=${code}`;
    await edit(
      `👥 *Реферальная программа*\n\nПриводи друзей — получай бесплатные месяцы\\.\n\n*Твоя ссылка:*\n\`${link.replace(/[_.*[\]()~>#+=|{}.!-]/g, '\\$&')}\`\n\n*Как работает:*\n1\\. Отправляешь ссылку другу\n2\\. Друг оформляет подписку\n3\\. Ты получаешь *\\+1 месяц бесплатно*\n\n📊 Приглашено: *${refs}*\n🎁 Бесплатных месяцев: *${free}*`,
      backKeyboard()
    );
  }

  else if (action === 'check_payment') {
    waitingHash.add(userId);
    await edit(
      `🔍 Вставь хэш транзакции следующим сообщением:`,
      { inline_keyboard: [[{ text: '← Отмена', callback_data: 'main' }]] }
    );
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;
  if (!waitingHash.has(userId)) return;

  waitingHash.delete(userId);

  if (text.length < 60) {
    return bot.sendMessage(userId,
      '⚠️ Это не похоже на хэш транзакции\\. Проверь и попробуй снова\\.',
      { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [[{ text: '🔄 Попробовать снова', callback_data: 'check_payment' }]] } }
    );
  }

  if (isPaid(userId)) {
    return bot.sendMessage(userId, '✅ Ты уже в списке\\! Конфиг придёт 10 апреля\\.', { parse_mode: 'MarkdownV2' });
  }

  if (isHashUsed(text)) {
    return bot.sendMessage(userId, '❌ Этот хэш уже использован\\.', { parse_mode: 'MarkdownV2' });
  }

  const wait = await bot.sendMessage(userId, '⏳ Проверяю транзакцию на блокчейне Tron\\.\\.\\.', { parse_mode: 'MarkdownV2' });
  const { ok, status, amount } = await verifyTronTx(text);

  const messages = {
    not_found: '❌ Транзакция не найдена\\. Возможно ещё не подтверждена — подожди 1\\-2 минуты и попробуй снова\\.',
    not_confirmed: '⏳ Транзакция найдена но ещё не подтверждена\\. Подожди пару минут\\.',
    wrong_amount: `❌ Сумма: *${amount?.toFixed(2)} USDT*\\. Нужно ровно *12 USDT*\\.`,
    error: '⚠️ Не удалось подключиться к блокчейну\\. Попробуй через минуту\\.',
  };

  if (!ok) {
    await bot.editMessageText(messages[status] || messages.error, {
      chat_id: userId, message_id: wait.message_id,
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: '🔄 Повторить', callback_data: 'check_payment' }]] }
    });
    return;
  }

  const refCode = userRefCodes.get(userId) || null;
  addSubscriber(userId, msg.from.username || String(userId), text, refCode);
  const total = totalSubscribers();

  await bot.editMessageText(
    `🎉 *Транзакция подтверждена\\!*\n\nСумма: *${amount.toFixed(2)} USDT* ✓\nСеть: *TRC\\-20* ✓\nСтатус: *SUCCESS* ✓\n\nТы в списке *РКН\\.НЕТ*\\. 10 апреля в 10:00 получишь конфиг прямо сюда в бот\\.`,
    {
      chat_id: userId, message_id: wait.message_id,
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: '📱 Как подключиться', callback_data: 'howto' }]] }
    }
  );

  // Уведомление админу
  try {
    await bot.sendMessage(ADMIN_ID,
      `💰 *Новая оплата\\!*\n👤 @${msg.from.username || userId}\n💵 ${amount.toFixed(2)} USDT\n📊 Всего подписчиков: ${total}`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (e) {}
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
