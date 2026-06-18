# 拼多多商家寄件机器人

通过企业微信接收收件人地址，自动完成地址解析、创建订单、快递比价、下发寄件。

## 架构

```
                   ┌─ 企业微信渠道 ─┐
用户消息 ── 多渠道 ─┼─ LLM 大模型    ─┼── router.js（业务逻辑）── pdd.js（PDD API）
                   └─ (可扩展)      ┘
                                          │
                                     Playwright 浏览器（常驻）
                                          │
                                     PDD 商家后台
```

- **渠道层**（`src/channels/`）：每个渠道一个适配器，消息收发统一格式
- **LLM 自然语言**：开启后所有消息走大模型，支持口语化指令
- **业务层**（`router.js`）：纯消息处理，不依赖具体渠道

## 快速开始

```bash
npm install
npx playwright install chromium
cp .env.example .env
# 编辑 .env，填入企业微信配置和发件人信息
node server.js
```

首次启动会自动登录拼多多商家后台，输入短信验证码后即可使用。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `WECOM_*` | 是 | 企业微信应用配置 |
| `PDD_USERNAME` / `PDD_PASSWORD` | 是 | 拼多多商家账号 |
| `PDD_SENDER_*` | 是 | 发件人地址信息 |
| `PORT` | 否 | 服务端口（默认 3456） |
| `PDD_HTTP_PROXY` | 否 | HTTP 代理（解决 VPS IP 风控） |

### LLM 配置

| 变量 | 说明 |
|------|------|
| `LLM_ENABLE=true` | 开启 LLM 自然语言模式，屏蔽菜单 |
| `LLM_API_KEY` | API Key |
| `LLM_MODEL` | 模型名（默认 `gpt-4o-mini`） |
| `LLM_BASE_URL` | API 地址（默认 OpenAI，换服务商时修改） |
| `LLM_SYSTEM_PROMPT` | 自定义系统提示词 |
| `LLM_SYSTEM_PROMPT_FILE` | 从文件读取系统提示词 |

支持所有 OpenAI 兼容接口：DeepSeek / 通义千问 / GLM / ollama 等。

## 自然语言示例

| 你说 | 效果 |
|------|------|
| `查一下待寄件` | 列出待寄件订单 |
| `把第一个寄了` | 自动比价 → 选最便宜 → 寄出 |
| `全部删除` | 清空待寄件 |
| `收货人:张三 138... 地址:浙江省...` | 创建订单+查询价格 |

## VPS IP 风控

在云服务器上运行时，PDD 可能对机房 IP 进行限制。解决方案：

1. **HTTP 代理**：设置 `PDD_HTTP_PROXY=http://代理地址`，请求走家庭宽带
2. **更换 IP**：云控制台更换弹性公网 IP
3. **购买住宅代理**：Smartproxy / IPRoyal 等

## 项目结构

```
├── server.js                  # Express 入口 + 渠道加载
├── src/
│   ├── channel.js             # 消息/回复基类 + 渠道接口
│   ├── channels/
│   │   ├── wecom.js           # 企业微信渠道适配器
│   │   ├── llm.js             # LLM 大模型调用引擎
│   │   └── llm-fn.js          # LLM 函数工具实现
│   ├── router.js              # 业务逻辑（纯消息处理）
│   ├── login.js               # 浏览器登录
│   ├── pdd.js                 # PDD API 客户端
│   ├── anti.js                # VM 沙箱 anti-content
│   ├── wechat.js              # 企业微信加解密 + API
│   ├── sms.js                 # 短信验证码接收
│   ├── config.js              # 配置加载
│   ├── db.js                  # SQLite 持久化
│   └── scheduler.js           # 定时任务
└── scripts/
    └── res.js                 # PDD webpack bundle
```

## 扩展新渠道

新建 `src/channels/xxx.js`，继承 `Channel` 类，实现 `start()` 和 `send()`：

```javascript
const { Channel, Message } = require('../channel');

class MyChannel extends Channel {
  async start() { /* 监听消息 */ }
  async send(reply, originalMsg) { /* 发送回复 */ }
}
```

在 `server.js` 中加载即可。

## 授权

MIT
