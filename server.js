/**
 * 拼多多手工寄件 + 多渠道消息机器人
 *
 * 启动: node server.js
 * PM2:  pm2 start ecosystem.config.js
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const db = require('./src/db');
const pdd = require('./src/pdd');
const { doLogin, startLoginLoop } = require('./src/login');
const sms = require('./src/sms');
const scheduler = require('./src/scheduler');

const app = express();

// ── 中间件 ──
app.use(cors());
app.use(express.text({ type: 'text/xml' }));
app.use(express.text({ type: 'application/xml' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════
//  渠道加载
// ═══════════════════════════════════════════════════════════

async function startChannels() {
  const { WeComChannel } = require('./src/channels/wecom');
  const wecom = new WeComChannel({ enable: true });
  wecom.app = app;
  await wecom.start();
  console.log('[channel] 企业微信渠道已启动');

  // LLM 自然语言渠道
  const { LlmChannel } = require('./src/channels/llm');
  require('./src/channels/llm-fn'); // 注册函数实现
  const llm = new LlmChannel({ enable: true });
  llm.app = app;
  await llm.start();
}

startChannels().catch(e => console.error('[channel] 启动失败:', e.message));

// SMS 短信接收
sms.registerRoutes(app);

// ═══════════════════════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
  const cookie = await pdd.getActiveCookie();
  res.json({
    status: 'ok',
    cookie: !!cookie,
    cookies: db.listCookies(),
    shipments: db.listShipments({}, 5),
  });
});

app.post('/api/login', async (req, res) => {
  try {
    const result = await doLogin();
    res.json({ success: true, mallName: result.mallName, cookies: result.cookies.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/cookie', (req, res) => {
  const { cookieString, cookies, mallId, mallName } = req.body;
  let cs = cookieString;
  if (!cs && Array.isArray(cookies)) cs = pdd.buildCookieString(cookies);
  if (!cs) return res.status(400).json({ error: '缺少 cookieString' });
  pdd.saveCookie(cs, mallId || '', mallName || '');
  pdd.testCookie().then(r => res.json({ saved: true, valid: r.valid, mallName: r.mallName }));
});

app.post('/api/ship', async (req, res) => {
  const { addressText, courierCode, user } = req.body;
  if (!addressText) return res.status(400).json({ error: '缺少 addressText' });
  try {
    const result = await pdd.sendFromAddress(addressText, courierCode);
    db.createShipment({
      manual_sn: result.manualSn, delivery_sn: result.deliverySn,
      waybill_code: result.waybillCode,
      receiver_name: result.receiver.consignee, receiver_mobile: result.receiver.phone,
      receiver_address: result.receiver.detail,
      receiver_province: result.receiver.province, receiver_city: result.receiver.city,
      receiver_district: result.receiver.district,
      receiver_province_id: String(result.receiver.provinceId),
      receiver_city_id: String(result.receiver.cityId),
      receiver_district_id: String(result.receiver.districtId),
      courier_name: result.courier.shipName, courier_code: result.courier.courierCode,
      ship_code: result.courier.shipCode, branch_id: result.courier.branchId,
      price: result.price.totalPrice, price_str: result.price.totalPriceStr,
      status: 'shipped', wechat_user: user || 'api',
    });
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/cancel', async (req, res) => {
  const { deliverySn } = req.body;
  if (!deliverySn) return res.status(400).json({ error: '缺少 deliverySn' });
  try {
    const r = await pdd.cancelShipment(deliverySn);
    const s = db.getShipmentByDelivery(deliverySn);
    if (s) db.updateShipment(s.manual_sn, { status: 'cancelled' });
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/shipments', (req, res) => {
  res.json(db.listShipments(req.query, parseInt(req.query.limit) || 50));
});

// ═══════════════════════════════════════════════════════════
//  启动
// ═══════════════════════════════════════════════════════════

const ts = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const PORT = config.port;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${ts()}] 服务已启动 port=${PORT}`);

  sms.startSocketListener();
  scheduler.startHeartbeat();
  scheduler.startDailySummary();

  if (config.pdd.username && config.pdd.password) {
    startLoginLoop();
  } else {
    console.log(`[${ts()}] 未配置 PDD_USERNAME, 需手动设置 Cookie`);
  }
});
