const pdd = require('./pdd');
const db = require('./db');
const { sendMessage } = require('./wechat');
const config = require('./config');

const ts = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

let _heartbeatTimer = null;
let _summaryTimer = null;

// ── Cookie 心跳（每2小时检测一次，仅在过期时触发登录） ──
async function heartbeat() {
  try {
    const cookie = pdd.getActiveCookie ? await pdd.getActiveCookie() : null;
    if (!cookie) return;
    const result = await pdd.testCookie();
    if (result.valid) {
      console.log(`[${ts()}] 心跳: Cookie 有效`);
    } else if (result.error && result.error.includes('过期')) {
      console.log(`[${ts()}] 心跳: Cookie 已过期，触发登录...`);
      const { doLogin } = require('./login');
      doLogin().catch(e => console.error(`[${ts()}] 登录失败: ${e.message}`));
    }
  } catch (e) {
    console.error(`[${ts()}] 心跳异常: ${e.message}`);
  }
}

function startHeartbeat(intervalMs = 2 * 3600 * 1000) {
  _heartbeatTimer = setInterval(heartbeat, intervalMs);
  _heartbeatTimer.unref();
  setTimeout(heartbeat, 5 * 60 * 1000);
}

// ── 每日 17:01 汇总 ──
function getYesterdayRange() {
  const now = new Date();
  const today17 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0);
  const yesterday17 = new Date(today17.getTime() - 24 * 3600 * 1000);

  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  };

  return {
    start: yesterday17.toISOString(), end: today17.toISOString(),
    dateLabel: fmt(yesterday17).split(' ')[0],
    startLabel: fmt(yesterday17), endLabel: fmt(today17),
  };
}

async function dailySummary() {
  const range = getYesterdayRange();
  if (db.isSummarySent(range.dateLabel)) return;

  try {
    const all = db.listShipments({}, 999);
    const shipped = all.filter(s => {
      if (s.status !== 'shipped') return false;
      const t = new Date(s.created_at + 'Z').getTime();
      return t >= new Date(range.start).getTime() && t < new Date(range.end).getTime();
    });

    if (!shipped.length) return;

    const totalPrice = shipped.reduce((sum, s) => sum + (s.price || 0), 0);
    const totalPriceStr = (totalPrice / 100).toFixed(2);
    const lines = [range.dateLabel + ' 寄件汇总', ''];

    shipped.forEach((s, i) => {
      const dest = [s.receiver_province, s.receiver_city, s.receiver_district].filter(Boolean).join('');
      lines.push(
        (i + 1) + '. ' + (s.waybill_code || '?') + ' · ' + s.price_str,
        '   ' + (s.courier_name || '?') + ' → ' + dest + ' · ' + s.receiver_name, ''
      );
    });

    lines.push('---');
    lines.push('共 ' + shipped.length + ' 单，快递费 ' + totalPriceStr + ' 元');
    const content = lines.join('\n');
    const users = [...new Set(shipped.map(s => s.wechat_user).filter(Boolean))];

    for (const user of users) {
      try { await sendMessage(user, content, 'text'); } catch (_) {}
    }
    db.markSummarySent(range.dateLabel);
  } catch (e) {
    console.error(`[${ts()}] 汇总异常: ${e.message}`);
  }
}

let _summaryRunning = false;
function startDailySummary() {
  const check = async () => {
    if (_summaryRunning) return;
    const now = new Date();
    if (now.getHours() === 17 && now.getMinutes() === 1) {
      _summaryRunning = true;
      try { await dailySummary(); } catch (_) {}
      _summaryRunning = false;
    }
  };
  _summaryTimer = setInterval(check, 60 * 1000);
  _summaryTimer.unref();
}

function stopAll() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  if (_summaryTimer) { clearInterval(_summaryTimer); _summaryTimer = null; }
}

module.exports = { startHeartbeat, startDailySummary, stopAll, dailySummary };
