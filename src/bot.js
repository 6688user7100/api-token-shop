import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'store.json');

// ==================== 数据存储 ====================

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { users: {}, keys: [], settings: { price_per_million: 5, admin_id: null } };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ==================== API 调用 ====================

async function callDeepSeek(prompt) {
  const response = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  return response.data;
}

// ==================== Key 管理 ====================

function generateKey(userId) {
  const key = `sk-${crypto.randomBytes(24).toString('hex')}`;
  const data = loadData();
  data.keys.push({
    key,
    userId,
    balance: 0, // 分销额度（单位：tokens）
    created: Date.now(),
    used: 0,
  });
  saveData(data);
  return key;
}

function getUserKey(userId) {
  const data = loadData();
  return data.keys.find(k => k.userId === userId);
}

function deductBalance(userId, tokens) {
  const data = loadData();
  const key = data.keys.find(k => k.userId === userId);
  if (!key || key.balance < tokens) return false;
  key.balance -= tokens;
  key.used += tokens;
  saveData(data);
  return true;
}

// ==================== 菜单布局 ====================

const mainMenu = {
  reply_markup: JSON.stringify({
    keyboard: [
      [{ text: '💰 余额查询' }, { text: '📊 账户信息' }],
      [{ text: '💎 充值额度' }, { text: '🔑 获取 Key' }],
      [{ text: '🤖 测试 API' }, { text: '⚙️ 管理后台' }],
    ],
    resize_keyboard: true,
  }),
};

const adminMenu = {
  reply_markup: JSON.stringify({
    keyboard: [
      [{ text: '📋 查看所有 Key' }, { text: '💹 设置价格' }],
      [{ text: '📈 销售报表' }, { text: '📨 广播消息' }],
      [{ text: '🔙 返回主菜单' }],
    ],
    resize_keyboard: true,
  }),
};

// ==================== Bot 核心 ====================

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// /start
bot.onText(/\/start/, (msg) => {
  const data = loadData();
  if (!data.users[msg.chat.id]) {
    data.users[msg.chat.id] = { joined: Date.now(), balance: 0 };
    saveData(data);
  }
  bot.sendMessage(msg.chat.id,
    `🤖 欢迎来到 API Token 商店！\n\n` +
    `这里可以充值获取 AI API 调用额度。\n` +
    `平台：DeepSeek（国内直连，速度快）\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📌 使用说明：\n` +
    `1. 点击「💎 充值额度」购买\n` +
    `2. 点击「🔑 获取 Key」获取你的专属 Key\n` +
    `3. 使用 Key 调用 DeepSeek API\n` +
    `━━━━━━━━━━━━━━━`,
    mainMenu
  );
});

// /admin（管理员命令）
bot.onText(/\/admin/, (msg) => {
  if (String(msg.chat.id) !== String(process.env.ADMIN_TG_ID)) {
    return bot.sendMessage(msg.chat.id, '⛔ 无权限');
  }
  bot.sendMessage(msg.chat.id, '🔧 管理后台', adminMenu);
});

// 按钮处理
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const text = msg.text;
  const chatId = msg.chat.id;
  const data = loadData();

  // ── 余额查询 ──
  if (text === '💰 余额查询') {
    const userKey = getUserKey(chatId);
    const user = data.users[chatId];
    const balance = userKey ? (userKey.balance / 1_000_000).toFixed(4) : 0;
    const used = userKey ? (userKey.used / 1_000_000).toFixed(4) : 0;
    bot.sendMessage(chatId,
      `📊 账户状态\n━━━━━━━━━━━━━━━\n` +
      `可用额度：${balance} M tokens\n` +
      `已消耗：${used} M tokens\n` +
      `━━━━━━━━━━━━━━━\n` +
      `提示：1 M = 100万 tokens`
    );
    return;
  }

  // ── 账户信息 ──
  if (text === '📊 账户信息') {
    const userKey = getUserKey(chatId);
    if (!userKey) {
      bot.sendMessage(chatId, '❗ 尚未创建 Key，请先点击「🔑 获取 Key」', mainMenu);
      return;
    }
    const price = data.settings.price_per_million;
    bot.sendMessage(chatId,
      `🔑 你的专属 Key\n━━━━━━━━━━━━━━━\n` +
      `\`${userKey.key}\`\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `⚠️ 请勿泄露此 Key！\n` +
      `售价：¥${price}/百万 tokens`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  // ── 获取 Key ──
  if (text === '🔑 获取 Key') {
    let userKey = getUserKey(chatId);
    if (!userKey) {
      const newKey = generateKey(chatId);
      bot.sendMessage(chatId,
        `✅ 新 Key 已生成！\n━━━━━━━━━━━━━━━\n` +
        `\`${newKey}\`\n\n` +
        `⚠️ 请妥善保管，切勿泄露！\n` +
        `━━━━━━━━━━━━━━━\n` +
        `首次使用请先充值额度`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    } else {
      bot.sendMessage(chatId,
        `🔑 你的 Key\n━━━━━━━━━━━━━━━\n` +
        `\`${userKey.key}\`\n\n` +
        `⚠️ 请勿泄露！`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }
    return;
  }

  // ── 充值 ──
  if (text === '💎 充值额度') {
    const price = data.settings.price_per_million;
    bot.sendMessage(chatId,
      `💎 充值额度\n━━━━━━━━━━━━━━━\n` +
      `DeepSeek API · ¥${price}/百万 tokens\n\n` +
      `📥 充值步骤：\n` +
      `1. 向管理员转账（注明 Tg ID）\n` +
      `2. 管理员手动加额\n\n` +
      `💬 请联系管理员充值`,
      mainMenu
    );
    return;
  }

  // ── 测试 API ──
  if (text === '🤖 测试 API') {
    const userKey = getUserKey(chatId);
    if (!userKey || userKey.balance <= 0) {
      bot.sendMessage(chatId, '❗ 额度不足或尚未获取 Key，请先充值！', mainMenu);
      return;
    }
    await bot.sendMessage(chatId, '🤖 测试中，请稍候...');
    try {
      const result = await callDeepSeek('用一句话介绍自己');
      const reply = result.choices[0].message.content;
      deductBalance(chatId, 30); // 估算消耗
      bot.sendMessage(chatId, `✅ 调用成功！\n━━━━━━━━━━━━━━━\n${reply}`);
    } catch (e) {
      bot.sendMessage(chatId, `❌ 调用失败：\n${e.message}`);
    }
    return;
  }

  // ── 管理后台 ──
  if (text === '⚙️ 管理后台') {
    if (String(chatId) !== String(process.env.ADMIN_TG_ID)) {
      bot.sendMessage(chatId, '⛔ 无权限访问');
      return;
    }
    bot.sendMessage(chatId, '🔧 管理后台', adminMenu);
    return;
  }

  // ── 管理员：查看所有 Key ──
  if (text === '📋 查看所有 Key' && String(chatId) === String(process.env.ADMIN_TG_ID)) {
    if (data.keys.length === 0) {
      bot.sendMessage(chatId, '暂无 Key 记录');
      return;
    }
    const lines = data.keys.map((k, i) =>
      `${i + 1}. 用户: ${k.userId}\n   余额: ${(k.balance / 1_000_000).toFixed(4)} M\n   已用: ${(k.used / 1_000_000).toFixed(4)} M`
    );
    bot.sendMessage(chatId, `📋 所有 Key\n━━━━━━━━━━━━━━━\n${lines.join('\n\n')}`, adminMenu);
    return;
  }

  // ── 管理员：价格设置 ──
  if (text === '💹 设置价格' && String(chatId) === String(process.env.ADMIN_TG_ID)) {
    const current = data.settings.price_per_million;
    bot.sendMessage(chatId,
      `💹 当前价格：¥${current}/百万 tokens\n\n` +
      `发送格式：\n\`/setprice 5\`\n（设置每百万 tokens ¥5）`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
    return;
  }

  // ── 管理员：销售报表 ──
  if (text === '📈 销售报表' && String(chatId) === String(process.env.ADMIN_TG_ID)) {
    const totalKeys = data.keys.length;
    const totalUsed = data.keys.reduce((s, k) => s + k.used, 0);
    const totalBalance = data.keys.reduce((s, k) => s + k.balance, 0);
    bot.sendMessage(chatId,
      `📈 销售报表\n━━━━━━━━━━━━━━━\n` +
      `Key 总数：${totalKeys}\n` +
      `总消耗：${(totalUsed / 1_000_000).toFixed(4)} M tokens\n` +
      `总剩余：${(totalBalance / 1_000_000).toFixed(4)} M tokens`,
      adminMenu
    );
    return;
  }

  // ── 管理员：广播 ──
  if (text === '📨 广播消息' && String(chatId) === String(process.env.ADMIN_TG_ID)) {
    bot.sendMessage(chatId, '📨 发送格式：\n`/broadcast 消息内容`', { parse_mode: 'Markdown', ...adminMenu });
    return;
  }

  // ── 返回主菜单 ──
  if (text === '🔙 返回主菜单') {
    bot.sendMessage(chatId, '🏠 主菜单', mainMenu);
    return;
  }

  // ── 默认回复 ──
  bot.sendMessage(chatId, `收到：${text}\n\n输入 /start 回到主菜单`, mainMenu);
});

// /setprice 管理员设置价格
bot.onText(/\/setprice (\d+\.?\d*)/, (msg, match) => {
  if (String(msg.chat.id) !== String(process.env.ADMIN_TG_ID)) return;
  const price = parseFloat(match[1]);
  const data = loadData();
  data.settings.price_per_million = price;
  saveData(data);
  bot.sendMessage(msg.chat.id, `✅ 价格已更新：¥${price}/百万 tokens`, adminMenu);
});

// /broadcast 广播消息
bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (String(msg.chat.id) !== String(process.env.ADMIN_TG_ID)) return;
  const msgText = match[1];
  const data = loadData();
  const userIds = Object.keys(data.users);
  let sent = 0;
  for (const uid of userIds) {
    try {
      bot.sendMessage(uid, `📢 公告\n━━━━━━━━━━━━━━━\n${msgText}`);
      sent++;
    } catch (e) { /* ignore */ }
  }
  bot.sendMessage(msg.chat.id, `✅ 已发送给 ${sent}/${userIds.length} 用户`, adminMenu);
});

// ==================== 启动 ====================

console.log('🤖 Bot 已启动！');
bot.on('polling_error', (err) => {
  console.error('Polling Error:', err.message);
});
