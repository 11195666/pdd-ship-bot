/**
 * 数据库 — 存储寄件记录和用户会话状态
 * 使用 SQLite (better-sqlite3) 零配置
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'pdd.db');

// 确保 data 目录存在
const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// 启用 WAL 模式提升并发性能
db.pragma('journal_mode = WAL');

// ── 表初始化 ──
db.exec(`
  CREATE TABLE IF NOT EXISTS shipments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    manual_sn     TEXT UNIQUE NOT NULL,     -- 手工订单号 MOD2606...
    delivery_sn   TEXT,                     -- 寄件单号 OD2606...
    waybill_code  TEXT,                     -- 运单号
    receiver_name TEXT,                     -- 收件人
    receiver_mobile TEXT,                   -- 收件人电话
    receiver_address TEXT,                  -- 收件地址（完整）
    receiver_province TEXT,
    receiver_city TEXT,
    receiver_district TEXT,
    receiver_province_id TEXT,
    receiver_city_id TEXT,
    receiver_district_id TEXT,
    courier_name  TEXT,                     -- 快递公司名称
    courier_code  TEXT,                     -- 快递公司代码
    ship_code     TEXT,                     -- 快递编码
    branch_id     INTEGER,                  -- 网点ID
    price         INTEGER,                  -- 价格（分）
    price_str     TEXT,                     -- 价格（元）
    status        TEXT DEFAULT 'created',   -- created / paid / shipped / cancelled
    wechat_user   TEXT,                     -- 企业微信用户名
    error_msg     TEXT,                     -- 错误信息
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    wechat_user   TEXT UNIQUE NOT NULL,     -- 企业微信用户ID
    state         TEXT DEFAULT 'idle',      -- idle / waiting_address / choosing_courier / confirm
    context       TEXT,                     -- JSON 上下文数据
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS summary_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key      TEXT UNIQUE NOT NULL,        -- YYYY-MM-DD
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS cookies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mall_id       TEXT,
    mall_name     TEXT,
    cookie_string TEXT NOT NULL,
    active        INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
  CREATE INDEX IF NOT EXISTS idx_shipments_wechat ON shipments(wechat_user);
  CREATE INDEX IF NOT EXISTS idx_sessions_wechat ON user_sessions(wechat_user);
  CREATE INDEX IF NOT EXISTS idx_cookies_active ON cookies(active);
`);

// ── 导出查询函数 ──

module.exports = {

  // ====== 寄件记录 ======

  createShipment(data) {
    const stmt = db.prepare(`
      INSERT INTO shipments (manual_sn, delivery_sn, waybill_code,
        receiver_name, receiver_mobile, receiver_address,
        receiver_province, receiver_city, receiver_district,
        receiver_province_id, receiver_city_id, receiver_district_id,
        courier_name, courier_code, ship_code, branch_id,
        price, price_str, status, wechat_user)
      VALUES (@manual_sn, @delivery_sn, @waybill_code,
        @receiver_name, @receiver_mobile, @receiver_address,
        @receiver_province, @receiver_city, @receiver_district,
        @receiver_province_id, @receiver_city_id, @receiver_district_id,
        @courier_name, @courier_code, @ship_code, @branch_id,
        @price, @price_str, @status, @wechat_user)
    `);
    return stmt.run(data);
  },

  updateShipment(manualSn, data) {
    const sets = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
    const stmt = db.prepare(`UPDATE shipments SET ${sets}, updated_at = datetime('now','localtime') WHERE manual_sn = @manualSn`);
    return stmt.run({ ...data, manualSn });
  },

  getShipment(manualSn) {
    return db.prepare('SELECT * FROM shipments WHERE manual_sn = ?').get(manualSn);
  },

  getShipmentByDelivery(deliverySn) {
    return db.prepare('SELECT * FROM shipments WHERE delivery_sn = ?').get(deliverySn);
  },

  listShipments(filter = {}, limit = 20) {
    let sql = 'SELECT * FROM shipments WHERE 1=1';
    const params = [];
    if (filter.status) { sql += ' AND status = ?'; params.push(filter.status); }
    if (filter.wechat_user) { sql += ' AND wechat_user = ?'; params.push(filter.wechat_user); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params);
  },

  // ====== 用户会话 ======

  setSession(wechatUser, state, context = null) {
    const existing = db.prepare('SELECT id FROM user_sessions WHERE wechat_user = ?').get(wechatUser);
    if (existing) {
      db.prepare(`UPDATE user_sessions SET state=?, context=?, updated_at=datetime('now','localtime') WHERE wechat_user=?`)
        .run(state, context ? JSON.stringify(context) : null, wechatUser);
    } else {
      db.prepare(`INSERT INTO user_sessions (wechat_user, state, context) VALUES (?,?,?)`)
        .run(wechatUser, state, context ? JSON.stringify(context) : null);
    }
  },

  getSession(wechatUser) {
    const row = db.prepare('SELECT * FROM user_sessions WHERE wechat_user = ?').get(wechatUser);
    if (!row) return null;
    return { ...row, context: row.context ? JSON.parse(row.context) : null };
  },

  clearSession(wechatUser) {
    db.prepare('DELETE FROM user_sessions WHERE wechat_user = ?').run(wechatUser);
  },

  // ====== Cookie 管理 ======

  saveCookie(cookieString, mallId, mallName) {
    // 先将所有旧 Cookie 标记为非活跃
    db.prepare('UPDATE cookies SET active=0').run();
    return db.prepare(
      'INSERT INTO cookies (mall_id, mall_name, cookie_string, active) VALUES (?,?,?,1)'
    ).run(mallId || '', mallName || '', cookieString);
  },

  getActiveCookie() {
    return db.prepare(
      'SELECT * FROM cookies WHERE active=1 ORDER BY updated_at DESC LIMIT 1'
    ).get();
  },

  markCookieExpired(id) {
    db.prepare('UPDATE cookies SET active=0 WHERE id=?').run(id);
  },

  listCookies() {
    return db.prepare(
      'SELECT id, mall_id, mall_name, active, created_at, updated_at FROM cookies ORDER BY updated_at DESC'
    ).all();
  },

  // ====== 汇总去重 ======

  markSummarySent(dateKey) {
    return db.prepare('INSERT OR IGNORE INTO summary_log (date_key) VALUES (?)').run(dateKey);
  },

  isSummarySent(dateKey) {
    return !!db.prepare('SELECT id FROM summary_log WHERE date_key = ?').get(dateKey);
  },
};
