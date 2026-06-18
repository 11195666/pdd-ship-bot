/**
 * SMS 接收服务
 *
 * 模式 A: 短信转发工具 POST webhook → /sms/receive
 * 模式 B: Socket.IO 连接已有短信服务 (可选)
 */

const { io: ioc } = require('socket.io-client');
const config = require('./config');

const ts = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

// 验证码等待
let _resolve = null;
let _timer = null;
const SMS_TIMEOUT = 120000;

function waitForCode() {
  return new Promise((resolve, reject) => {
    _resolve = resolve;
    _timer = setTimeout(() => {
      _resolve = null; _timer = null;
      reject(new Error('等待验证码超时 (2分钟)'));
    }, SMS_TIMEOUT);
  });
}

function feedCode(code) {
  if (_resolve) {
    clearTimeout(_timer);
    const r = _resolve;
    _resolve = null; _timer = null;
    console.log(`[${ts()}] 短信: 验证码 ${code} → 登录流程`);
    r(code);
    return true;
  }
  return false;
}

// 提取验证码: 优先匹配"验证码"后面的数字，避免发件人号码被误识别
function extractCode(text) {
  if (!text) return null;
  const keywordMatch = text.match(/验证码[是为：:]\s*(\d{4,8})/);
  if (keywordMatch) return keywordMatch[1];
  const fallback = text.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return fallback ? fallback[1] : null;
}

// 检查是否拼多多来源
const PDD_KEYWORDS = ['拼多多', 'pinduoduo', 'pdd', 'mms.pinduoduo', '商家后台'];

function isPddSms(text) {
  if (!text) return false;
  return PDD_KEYWORDS.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
}

function handleSms(title, content, source) {
  // 只从短信正文提取验证码，避免发件人号码被误判
  const code = extractCode(content || '') || extractCode((title || '') + ' ' + (content || ''));
  if (!code) return;
  const fullText = (title || '') + ' ' + (content || '');
  if (source === 'socketio' && !isPddSms(fullText)) return;
  console.log(`[${ts()}] 短信: 验证码 ${code} (来源: ${source || 'webhook'})`);
  feedCode(code);
}

// =========================================================
// 模式 A: Express 路由
// =========================================================

function registerRoutes(app) {
  app.post('/sms/receive', (req, res) => {
    const { title, content, body, text, from, sender } = req.body || {};
    handleSms(title || from || sender || '', content || body || text || JSON.stringify(req.body));
    res.json({ success: true });
  });

  app.post('/sms/webhook', (req, res) => {
    const body = req.body;
    let text = '';
    if (typeof body === 'string') text = body;
    else text = body?.body || body?.text || body?.content || body?.sms || body?.code || '';
    handleSms(body?.title || body?.from || body?.sender || '', text);
    res.json({ success: true });
  });
}

// =========================================================
// 模式 B: Socket.IO (可选)
// =========================================================

let _socket = null;

function startSocketListener() {
  const url = config.smsSocketIOUrl;
  if (!url) {
    console.log(`[${ts()}] 短信: 使用 webhook 模式 (POST /sms/receive)`);
    return;
  }

  _socket = ioc(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });

  _socket.on('connect', () => {
    console.log(`[${ts()}] 短信: Socket.IO 已连接`);
  });

  _socket.on('new_sms', (msg) => {
    const title = msg.title || '';
    const content = msg.content || msg.body || msg.text || '';
    handleSms(title, content, 'socketio');
  });

  _socket.on('disconnect', (reason) => {
    console.log(`[${ts()}] 短信: Socket.IO 断开 (${reason})`);
  });

  _socket.on('connect_error', (err) => {
    console.log(`[${ts()}] 短信: Socket.IO 连接错误 — ${err.message}`);
  });
}

function stopSocketListener() {
  if (_socket) { _socket.disconnect(); _socket = null; }
}

module.exports = {
  registerRoutes, startSocketListener, stopSocketListener,
  waitForCode, feedCode, handleSms,
};
