import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'database.sqlite'));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 健康检查 ====================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==================== 数据库初始化 ====================

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    balance INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    balance INTEGER DEFAULT 0,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS topup_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    proof_img TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    api_key_id TEXT,
    tokens INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    model TEXT,
    provider TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// 初始化默认设置
const defaultSettings = {
  price_per_million: '1',
  deepseek_api_key: '',
  dashscope_api_key: process.env.DASHSCOPE_API_KEY || '',
  provider: 'dashscope',   // 'dashscope' | 'deepseek'
};
for (const [k, v] of Object.entries(defaultSettings)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
}

// ==================== 辅助函数 ====================

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? JSON.parse(row.value) : null;
}

function PRICE_PER_MILLION() {
  return parseFloat(getSetting('price_per_million') || '1');
}

function getProviderConfig() {
  const provider = getSetting('provider') || 'dashscope';
  const config = { provider };

  if (provider === 'dashscope') {
    config.apiKey = getSetting('dashscope_api_key');
    config.endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    // 模型映射（前端传模型名，后端对应路由）
    config.defaultModel = 'qwen-plus';
  } else {
    config.apiKey = getSetting('deepseek_api_key');
    config.endpoint = 'https://api.deepseek.com/chat/completions';
    config.defaultModel = 'deepseek-chat';
  }

  return config;
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token 无效' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: '需要管理员权限' });
    next();
  });
}

// ==================== 认证接口 ====================

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '请填写完整信息' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const exist = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (exist) return res.status(400).json({ error: '该邮箱已注册' });

  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, email, password) VALUES (?,?,?)').run(id, email, hash);
  res.json({ message: '注册成功' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) return res.status(401).json({ error: '邮箱或密码错误' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: '邮箱或密码错误' });

  const token = jwt.sign({ id: user.id, email: user.email, is_admin: !!user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, is_admin: !!user.is_admin, email: user.email });
});

// ==================== 用户接口 ====================

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, balance, is_admin, created_at FROM users WHERE id=?').get(req.user.id);
  const keys = db.prepare('SELECT id, api_key, balance, used, created_at FROM api_keys WHERE user_id=?').all(req.user.id);
  const provider = getSetting('provider') || 'dashscope';
  res.json({ user, keys, provider });
});

app.post('/api/keys', requireAuth, (req, res) => {
  const apiKey = 'sk-' + uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '').slice(0, 24);
  const id = uuidv4();
  db.prepare('INSERT INTO api_keys (id, user_id, api_key) VALUES (?,?,?)').run(id, req.user.id, apiKey);
  res.json({ api_key: apiKey, id });
});

app.delete('/api/keys/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ message: '已删除' });
});

app.post('/api/topup', requireAuth, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: '请输入有效金额' });
  const id = uuidv4();
  db.prepare('INSERT INTO topup_requests (id, user_id, amount) VALUES (?,?,?)').run(id, req.user.id, amount);
  res.json({ message: '申请已提交，等待管理员审核', id });
});

app.get('/api/topup', requireAuth, (req, res) => {
  const orders = db.prepare("SELECT * FROM topup_requests WHERE user_id=? ORDER BY created_at DESC").all(req.user.id);
  res.json(orders);
});

// ==================== AI 对话代理（支持 DeepSeek / 阿里云百炼）====================

app.post('/api/chat', requireAuth, async (req, res) => {
  const { api_key, messages, model } = req.body;

  // 验证 Key 所属
  const keyRec = db.prepare('SELECT * FROM api_keys WHERE api_key=? AND user_id=?').get(api_key, req.user.id);
  if (!keyRec) return res.status(403).json({ error: 'Key 无效或不属于你' });

  const providerConfig = getProviderConfig();
  if (!providerConfig.apiKey) {
    return res.status(500).json({ error: '上游 API 未配置，请联系管理员' });
  }

  // 模型处理：DeepSeek → 透传；阿里云百炼 → 统一前缀映射
  let targetModel = model || providerConfig.defaultModel;
  if (providerConfig.provider === 'dashscope') {
    // 百炼模型映射（兼容 qwen-plus、qwen-max 等）
    // 透传即可，DashScope 接受 qwen-plus、qwen-turbo 等
  }

  try {
    const response = await axios.post(
      providerConfig.endpoint,
      {
        model: targetModel,
        messages,
        max_tokens: 2048,
        stream: false,
      },
      {
        headers: {
          'Authorization': `Bearer ${providerConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    const usage = response.data.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    // 响应文本 token 数按 output 估算（汉字 ≈ 字符 × 1.5）
    const totalTokens = inputTokens + outputTokens;

    const price = PRICE_PER_MILLION();
    const cost = (totalTokens / 1_000_000) * price;

    // 扣余额（至少扣 input_tokens + 估算 output）
    if (keyRec.balance < totalTokens) {
      return res.status(402).json({ error: '额度不足，请充值' });
    }
    db.prepare('UPDATE api_keys SET balance=balance-?, used=used+? WHERE id=?').run(totalTokens, totalTokens, keyRec.id);

    // 记录日志
    db.prepare('INSERT INTO usage_logs (id, user_id, api_key_id, tokens, cost, model, provider) VALUES (?,?,?,?,?,?,?)').run(
      uuidv4(), req.user.id, keyRec.id, totalTokens, cost, targetModel, providerConfig.provider
    );

    res.json({
      reply: response.data.choices[0].message.content,
      usage,
      cost,
      provider: providerConfig.provider,
      model: targetModel,
    });
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.response?.data?.error?.code || e.message;
    console.error('API 调用失败:', providerConfig.provider, errMsg);
    res.status(500).json({ error: errMsg });
  }
});

// ==================== 管理后台接口 ====================

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, balance, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.get('/api/admin/topups', requireAdmin, (req, res) => {
  const topups = db.prepare(`
    SELECT tr.*, u.email FROM topup_requests tr
    JOIN users u ON tr.user_id=u.id
    ORDER BY tr.created_at DESC
  `).all();
  res.json(topups);
});

app.post('/api/admin/topup/:id/:action', requireAdmin, (req, res) => {
  const { action } = req.params;
  const topup = db.prepare('SELECT * FROM topup_requests WHERE id=?').get(req.params.id);
  if (!topup) return res.status(404).json({ error: '申请不存在' });
  if (topup.status !== 'pending') return res.status(400).json({ error: '已处理' });

  if (action === 'approve') {
    const price = PRICE_PER_MILLION();
    const tokens = Math.floor((topup.amount / price) * 1_000_000);
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(tokens, topup.user_id);
    db.prepare("UPDATE topup_requests SET status='approved' WHERE id=?").run(req.params.id);
    res.json({ message: `已审批，给用户加 ${(tokens/1_000_000).toFixed(2)} M tokens` });
  } else {
    db.prepare("UPDATE topup_requests SET status='rejected' WHERE id=?").run(req.params.id);
    res.json({ message: '已拒绝' });
  }
});

app.post('/api/admin/price', requireAdmin, (req, res) => {
  const { price } = req.body;
  if (!price || price <= 0) return res.status(400).json({ error: '价格无效' });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('price_per_million', ?)").run(JSON.stringify(String(price)));
  res.json({ message: `价格已更新为 ¥${price}/百万 tokens` });
});

app.post('/api/admin/provider', requireAdmin, (req, res) => {
  const { provider, api_key } = req.body;
  if (!['dashscope', 'deepseek'].includes(provider)) return res.status(400).json({ error: '不支持该服务商' });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('provider', ?)").run(JSON.stringify(provider));
  if (api_key) {
    const keyName = provider === 'dashscope' ? 'dashscope_api_key' : 'deepseek_api_key';
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(keyName, JSON.stringify(api_key));
  }
  res.json({ message: `已切换到 ${provider === 'dashscope' ? '阿里云百炼' : 'DeepSeek'}` });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    price: PRICE_PER_MILLION(),
    provider: getSetting('provider') || 'dashscope',
    hasDashscopeKey: !!getSetting('dashscope_api_key'),
    hasDeepseekKey: !!getSetting('deepseek_api_key'),
  });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as total FROM users').get().total;
  const keys = db.prepare('SELECT COUNT(*) as total FROM api_keys').get().total;
  const totalUsed = db.prepare('SELECT COALESCE(SUM(tokens),0) as t FROM usage_logs').get().t;
  const pendingTopups = db.prepare("SELECT COUNT(*) as c FROM topup_requests WHERE status='pending'").get().c;
  const revenue = db.prepare("SELECT COALESCE(SUM(cost),0) as r FROM usage_logs").get().r;
  res.json({ users, keys, totalUsed: Math.round(totalUsed), pendingTopups, revenue: parseFloat(revenue.toFixed(4)) });
});

app.post('/api/admin/adjust-balance', requireAdmin, (req, res) => {
  const { user_id, amount } = req.body;
  // amount: 正数=增加，负数=减少，单位：tokens
  if (!user_id || !amount) return res.status(400).json({ error: '参数不完整' });
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(user_id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const newBalance = db.prepare('UPDATE users SET balance=balance+? WHERE id=? RETURNING balance').run(amount, user_id);
  db.prepare('INSERT INTO usage_logs (id, user_id, tokens, cost, model, provider) VALUES (?, ?, ?, ?, ?, ?)').run(
    uuidv4(), user_id, Math.abs(amount), 0,
    amount > 0 ? 'admin_add' : 'admin_subtract', 'system'
  );
  const updated = db.prepare('SELECT balance FROM users WHERE id=?').get(user_id);
  res.json({ message: `已${amount > 0 ? '增加' : '减少'} ${Math.abs(amount/1_000_000).toFixed(2)} M tokens`, newBalance: updated.balance });
});

// ==================== 调用日志监控 ====================
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const userId = req.query.user_id || '';
  const provider = req.query.provider || '';

  let where = '1=1';
  let params = [];
  if (userId) { where += ' AND ul.user_id=?'; params.push(userId); }
  if (provider) { where += ' AND ul.provider=?'; params.push(provider); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM usage_logs ul WHERE ${where}`).get(...params).c;
  const logs = db.prepare(`
    SELECT ul.*, u.email, k.api_key
    FROM usage_logs ul
    LEFT JOIN users u ON ul.user_id=u.id
    LEFT JOIN api_keys k ON ul.api_key_id=k.id
    WHERE ${where}
    ORDER BY ul.created_at DESC LIMIT ? OFFSET?
  `).all(...params, limit, offset);

  res.json({ logs, total, page, limit, totalPages: Math.ceil(total / limit) });
});

app.get('/api/admin/logs/export', requireAdmin, (req, res) => {
  const logs = db.prepare(`
    SELECT ul.created_at, u.email, ul.model, ul.provider, ul.tokens, ul.cost, k.api_key
    FROM usage_logs ul
    LEFT JOIN users u ON ul.user_id=u.id
    LEFT JOIN api_keys k ON ul.api_key_id=k.id
    ORDER BY ul.created_at DESC
  `).all();
  // 简单 CSV 导出
  let csv = '\uFEFF时间,用户,模型,服务商,Tokens,费用,API Key\n';
  for (const l of logs) {
    csv += `${l.created_at},${l.email},${l.model},${l.provider},${l.tokens},${l.cost},${l.api_key || '-'}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=logs.csv');
  res.send(csv);
});

// ==================== 临时调试端点 ====================
app.get('/api/debug-token', (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE email='66881056@qq.com'").get();
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const token = jwt.sign({ id: user.id, email: user.email, is_admin: !!user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, email: user.email, is_admin: !!user.is_admin });
});

// ==================== 启动 ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 服务器已启动：http://localhost:${PORT}`);
  console.log(`📂 数据库：${path.join(__dirname, 'database.sqlite')}`);
  const cfg = getProviderConfig();
  console.log(`🤖 当前上游：${cfg.provider === 'dashscope' ? '阿里云百炼' : 'DeepSeek'}`);
});
