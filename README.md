# 🤖 API Token 转售学习项目

通过 Telegram Bot 从零搭建一个 API Token 分销平台。

---

## 系统架构

```
用户 Telegram
    ↓
Telegram Bot（Node.js）
    ↓
DeepSeek API（或其他平台）
```

---

## 项目目录

```
api-token-shop/
├── .env.example      ← 环境变量模板
├── package.json
├── src/
│   ├── bot.js        ← 核心 Bot 代码
│   └── data/
│       └── store.json ← 数据存储（自动生成）
```

---

## 第一步：注册账号（需要自己操作）

### 1. Telegram Bot
1. 打开 Telegram，搜索 **@BotFather**
2. 发送 `/newbot`
3. 按提示设置名称 → 获取 `BOT_TOKEN`（格式：`123456789:ABCDefGh...`）
4. 记下你的 **Tg User ID**（搜索 **@userinfobot** 发送任意消息获取）

### 2. DeepSeek API（免费额度）
1. 打开 https://platform.deepseek.com/
2. 注册账号 → 进入控制台
3. 左侧菜单 → API Keys → 创建新 Key
4. 充值一点钱（几块钱够学习测试）

---

## 第二步：安装依赖

```bash
cd C:\Users\66881\.qclaw\workspace\api-token-shop
npm install
```

---

## 第三步：配置环境变量

复制配置文件，填入你自己的信息：

```bash
copy .env.example .env
```

编辑 `.env`：

```env
TELEGRAM_BOT_TOKEN=123456789:ABCDefGh_你的_bot_token
DEEPSEEK_API_KEY=sk-你的_deepseek_api_key
ADMIN_TG_ID=你的_tg_user_id
```

---

## 第四步：启动

```bash
npm start
```

看到 `🤖 Bot 已启动！` 就成功了。

---

## 功能一览

| 按钮 | 功能 |
|------|------|
| 💰 余额查询 | 查看当前额度 |
| 📊 账户信息 | 查看自己的 Key |
| 🔑 获取 Key | 生成/查看专属 API Key |
| 💎 充值额度 | 了解充值方式 |
| 🤖 测试 API | 在 Bot 里直接测试 DeepSeek |
| ⚙️ 管理后台 | 管理员功能（需 ADMIN_TG_ID） |

### 管理员命令

| 命令 | 功能 |
|------|------|
| `/admin` | 打开管理后台 |
| `/setprice 5` | 设置价格（元/百万tokens） |
| `/broadcast 消息` | 向所有用户广播 |
| `/start` | 主菜单 |

---

## 进阶方向（后续可扩展）

- **加支付**：接入微信/支付宝收款
- **加 Web 面板**：用户自己注册、充值、查余额
- **多平台**：接入 OpenAI、Claude 等多 API 源
- **自动化**：充值后自动发 Key，无需人工介入
- **监控**：用户用量预警、防滥用

---

## 注意事项

⚠️ 这是**学习测试项目**，请勿用于生产环境：
- 数据存储用本地 JSON，没有加密
- 没有数据库并发处理
- 没有安全防护机制
