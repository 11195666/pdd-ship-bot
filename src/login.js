/**
 * 登录 + anti-content 生成 (route 注入方案, 已验证可用)
 *
 * 登录后保持浏览器在 Express 页面。
 * page.route 拦截 webpack runtime JS (5KB), 注入 window.sj=_ 暴露 require。
 * 寄件时 page.evaluate 调用 window.sj('fbeZ') 在真实浏览器环境生成 anti-content。
 */

const { chromium } = require('playwright');
const config = require('./config');
const sms = require('./sms');

let _db = null;
const getDb = () => { if (!_db) _db = require('./db'); return _db; };
const ts = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

// 代理支持（与 pdd.js 共用 PDD_HTTP_PROXY）
const proxyUrl = process.env.PDD_HTTP_PROXY || '';
let _proxyCtxOpt = {};
if (proxyUrl) {
  // Playwright 原生支持 HTTP 和 SOCKS5 代理
  _proxyCtxOpt = { proxy: { server: proxyUrl } };
}

let _browser = null;
let _context = null;
let _page = null;
let _sjReady = false;

// ═══════════════════════ 登录 ═══════════════════════

async function doLogin() {
  const username = config.pdd.username;
  const password = config.pdd.password;
  if (!username || !password) throw new Error('缺少 PDD_USERNAME / PDD_PASSWORD');

  console.log(`[${ts()}] 登录: 启动浏览器...`);
  if (_browser) { try { await _browser.close(); } catch (_) {} }

  _browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
           '--disable-blink-features=AutomationControlled'],
  });
  _context = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
    ..._proxyCtxOpt,
  });
  _page = await _context.newPage();
  _sjReady = false;

  // 反检测：抹掉 Playwright 自动化痕迹
  await _page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
  });

  await _page.goto(`${config.pddLoginUrl}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await _page.waitForTimeout(4000);

  await _page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(e =>
      ['账号登录','密码登录','账号密码登录'].includes((e.textContent||'').trim()));
    if (el) el.click();
  });
  await _page.waitForTimeout(1000);

  await _page.locator('#usernameId').click({ force: true });
  await _page.locator('#usernameId').fill(username);
  await _page.waitForTimeout(300);
  await _page.locator('#passwordId').click({ force: true });
  await _page.locator('#passwordId').fill(password);
  await _page.waitForTimeout(500);
  console.log(`[${ts()}] 登录: 已填写`);

  await _page.locator('button:has-text("登录")').first().click({ force: true });
  await _page.waitForTimeout(2000);

  const hasCode = await _page.evaluate(() =>
    !!document.querySelector('input[placeholder*="验证码"], input[placeholder*="短信"]'));
  if (hasCode) {
    console.log(`[${ts()}] 登录: 等待验证码...`);
    const code = await sms.waitForCode();
    console.log(`[${ts()}] 登录: 填入 ${code}`);
    await _page.locator('input[placeholder*="验证码"], input[placeholder*="短信"]').first().fill(code);
    await _page.waitForTimeout(300);
    await _page.locator('button:has-text("确认"), button:has-text("确定"), button:has-text("登录"), button:has-text("提交")').first().click({ force: true });
    await _page.waitForTimeout(3000);
  }

  let loggedIn = false;
  try {
    await _page.waitForURL(u => !u.includes('/login') && !u.includes('/passport'), { timeout: 25000 });
    loggedIn = true;
  } catch (_) {}
  if (!loggedIn) {
    const hasLoginForm = await _page.evaluate(() =>
      !!document.querySelector('#usernameId') || !!document.querySelector('input[placeholder*="手机"]'));
    loggedIn = !hasLoginForm;
  }
  if (!loggedIn) throw new Error('登录超时');

  const cookies = await _context.cookies();
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const mallName = (await _page.title()).replace(/[\\-].*/, '').trim();
  getDb().saveCookie(cookieString, '', mallName);
  console.log(`[${ts()}] 登录成功: ${mallName}`);

  await navigateToExpress();
  return { cookieString, mallName, cookies };
}

// ═══════════════════════ 导航至寄件页面 (含 route 注入) ═══════════════════════

async function navigateToExpress() {
  _sjReady = false;

  // 拦截 webpack runtime，注入 window.sj=X 暴露 require 函数
  // 用 .m= 模式自动检测 require 变量名，在最后的 }([]); 之前注入
  await _page.route(/webpack-[a-f0-9]+\.js$/, async (route) => {
    try {
      const resp = await route.fetch();
      let body = await resp.text();
      if (body.includes('webpackJsonp') && body.length < 10000 && !body.includes('window.sj')) {
        const reqMatch = body.match(/\b(\w+)\.m\s*=\s*\w+/);
        if (reqMatch) {
          const reqFn = reqMatch[1];
          // 在最后的 X()}([]); 之前注入 (不依赖 $ 锚点，兼容尾部注释)
          const injected = body.replace(
            /(\w+\(\)\}\(\[\]\);)/g,
            `window.sj=${reqFn};$1`
          );
          // 全局替换可能注入多次，检查是否只注入了一次
          if (injected !== body) {
            body = injected;
            console.log(`[${ts()}] runtime 注入 window.sj=${reqFn}`);
          }
        }
      }
      await route.fulfill({ response: resp, body });
    } catch (_) { await route.continue(); }
  });

  await _page.goto(config.pddLoginUrl + '/express/expressOnlineNew?from=orignal&msfrom=mms_sidenav',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _page.waitForTimeout(8000);

  // 验证 window.sj
  const check = await _page.evaluate(() => {
    if (typeof window.sj === 'function') {
      try {
        const m = window.sj('fbeZ');
        const G = window.sj('0JBe');
        const st = (G && G.a && G.a.getInstance) ? G.a.getInstance().getTimeFromCache() || Date.now() : Date.now();
        const K = window.sj.n ? window.sj.n(m) : m;
        const anti = new K.a({ serverTime: st }).messagePack();
        return { ok: true, len: anti.length };
      } catch (e) { return { ok: false, err: e.message }; }
    }
    return { ok: false, sj: typeof window.sj };
  });

  if (check.ok) {
    _sjReady = true;
    console.log(`[${ts()}] window.sj 就绪 (${check.len}chars)`);
  } else {
    console.log(`[${ts()}] window.sj 未就绪: ${JSON.stringify(check)}`);
  }
}

// ═══════════════════════ Cookie 有效时启动 ═══════════════════════

async function startBrowserWithCookie() {
  if (_browser) { try { await _browser.close(); } catch (_) {} }

  _browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
           '--disable-blink-features=AutomationControlled'],
  });
  _context = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
    ..._proxyCtxOpt,
  });

  const row = getDb().getActiveCookie();
  if (row && row.cookie_string) {
    const list = row.cookie_string.split('; ').map(c => {
      const idx = c.indexOf('=');
      return { name: c.slice(0, idx), value: c.slice(idx + 1), domain: '.pinduoduo.com', path: '/' };
    }).filter(c => c.name);
    await _context.addCookies(list);
  }

  _page = await _context.newPage();

  await _page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
  });

  await navigateToExpress();
}

async function getBrowserCookie() {
  if (!_page) return null;
  try {
    const cookies = await _context.cookies();
    // 去重：同名 cookie 只保留最后一条（最新的）
    const map = new Map();
    for (const c of cookies) map.set(c.name, c.value);
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  } catch (_) { return null; }
}

// ═══════════════════════ 浏览器内寄件 + anti-content ═══════════════════════

/**
 * 浏览器内寄件：在 page.evaluate 中生成 anti-content 并发 fetch。
 * 所有操作在同一浏览器上下文中完成，cookie 和指纹自然一致。
 * 这是首选的寄件路径，失败后 fallback 到 generateAntiContent() + axios。
 *
 * 注意：VM 沙箱/浏览器生成的 anti-content 可能被 PDD 基于 IP 风控拦截，
 * 非家庭宽带 IP（如 VPS 机房）可能触发。解决方案见 README。
 */
async function shipOrderViaBrowser(url, bodyObj) {
  if (!_page) return null;

  if (!_sjReady) {
    try { await navigateToExpress(); } catch (_) {}
  }
  if (!_sjReady) {
    console.log(`[${ts()}] ship: window.sj 未就绪`);
    return null;
  }

  const result = await _page.evaluate(async ({ url, bodyStr }) => {
    try {
      // 1. 在浏览器中生成 anti-content（使用浏览器自身的 window.sj）
      if (typeof window.sj !== 'function') return { __error: 'no_sj' };
      const m = window.sj('fbeZ');
      const G = window.sj('0JBe');
      const st = (G && G.a && G.a.getInstance) ? G.a.getInstance().getTimeFromCache() || Date.now() : Date.now();
      const K = window.sj.n ? window.sj.n(m) : m;
      const anti = new K.a({ serverTime: st }).messagePack();
      if (!anti || anti.length < 20) return { __error: 'anti_too_short' };

      // 2. 用同一个浏览器上下文发 fetch（带上 anti-content header）
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anti-content': anti,
        },
        body: bodyStr,
        credentials: 'include',
      });
      const json = await resp.json();
      // 如果 PDD 返回了具体的错误码，透传给上层
      return json;
    } catch (e) {
      return { __error: e.message };
    }
  }, { url, bodyStr: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj) });

  return result;
}

async function generateAntiContent() {
  if (!_page) return null;

  if (!_sjReady) {
    try { await navigateToExpress(); } catch (_) {}
  }

  if (!_sjReady) {
    console.log(`[${ts()}] window.sj 未就绪, fallback 到 VM 沙箱`);
    return await generateAntiContentVM();
  }

  const result = await _page.evaluate(() => {
    try {
      if (typeof window.sj !== 'function') return 'E:no_sj';
      const m = window.sj('fbeZ');
      const G = window.sj('0JBe');
      const st = (G && G.a && G.a.getInstance) ? G.a.getInstance().getTimeFromCache() || Date.now() : Date.now();
      const K = window.sj.n ? window.sj.n(m) : m;
      const anti = new K.a({ serverTime: st }).messagePack();
      if (anti && anti.length > 20) return anti;
      return 'E:too_short_' + (anti ? anti.length : 0);
    } catch (e) {
      return 'E:' + e.message;
    }
  });

  if (result && !String(result).startsWith('E:') && result.length > 20) return result;

  console.log(`[${ts()}] 浏览器生成失败: ${String(result).slice(0, 80)}, fallback 到 VM 沙箱`);
  return await generateAntiContentVM();
}

// VM 沙箱 fallback: 加载 scripts/res.js 生成 anti-content
async function generateAntiContentVM() {
  const { generateAntiContent } = require('./anti');
  const row = getDb().getActiveCookie();
  const cookieStr = row ? row.cookie_string : '';
  const result = await generateAntiContent(cookieStr);
  // anti.js 返回 { antiContent, cookie } 对象
  if (result && typeof result === 'object' && result.antiContent) {
    return result.antiContent;
  }
  // 兼容旧返回（纯字符串）
  if (typeof result === 'string' && result.length > 20) {
    return result;
  }
  return null;
}

// ═══════════════════════ 启动循环 ═══════════════════════

async function startLoginLoop() {
  const db = getDb();
  const row = db.getActiveCookie();

  if (row) {
    try {
      const pdd = require('./pdd');
      const r = await pdd.testCookie();
      if (r.valid) {
        console.log(`[${ts()}] Cookie 有效, 启动浏览器...`);
        return await startBrowserWithCookie();
      }
    } catch (_) {}
    console.log(`[${ts()}] Cookie 过期, 重新登录...`);
    return await doLogin().catch(() => {});
  }

  console.log(`[${ts()}] 无 Cookie, 登录...`);
  return await doLogin().catch(e => {
    console.error(`[${ts()}] 登录失败: ${e.message}, 5分钟后重试`);
    setTimeout(() => startLoginLoop(), 5 * 60 * 1000);
  });
}

module.exports = { doLogin, startLoginLoop, stopLoginLoop: () => {
  if (_browser) { _browser.close().catch(() => {}); _browser = null; _context = null; _page = null; _sjReady = false; }
}, generateAntiContent, shipOrderViaBrowser, getBrowserCookie };
