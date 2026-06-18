/**
 * anti-content 生成模块 (VM 沙箱 fallback)
 *
 * 加载 scripts/res.js（PDD webpack bundle）到 VM 沙箱中,
 * 调用 fbeZ 模块的 messagePack() 生成 anti-content 签名。
 *
 * 关键点:
 * - Cookie 在加载 res.js 前注入 document.cookie
 * - Date.now 被接管使用 PDD 服务端时间
 * - Cookie 用 defineProperty 锁定防止被覆写
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 代理支持（与 pdd.js 共用 PDD_HTTP_PROXY）
const proxyUrl = process.env.PDD_HTTP_PROXY || '';
let proxyAgent = null;
if (proxyUrl) {
  try { proxyAgent = new (require('https-proxy-agent').HttpsProxyAgent)(proxyUrl); } catch (_) {}
}
const proxyOpt = () => proxyAgent ? { httpsAgent: proxyAgent } : {};

const CODE_PATH = path.join(__dirname, '..', 'scripts', 'res.js');
const code = fs.readFileSync(CODE_PATH, 'utf8');

// 与 pdd.js 中 axios 请求头保持完全一致
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchServerTime(cookieStr) {
  try {
    const resp = await axios.get('https://api.pinduoduo.com/api/server/_stm', {
      headers: { 'Cookie': cookieStr || '', 'User-Agent': UA },
      timeout: 5000,
      ...proxyOpt(),
    });
    if (resp.data && resp.data.server_time) return resp.data.server_time;
  } catch (_) {}
  return null;
}

async function generateAntiContent(cookieStr) {
  // 1. 获取 PDD 服务端真实时间
  const serverTime = await fetchServerTime(cookieStr) || Date.now();

  // 2. 初始化 sandbox, 在加载 res.js 之前就注入 cookie
  const sandbox = {
    global, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Array, Object, Date, Error, String, Number, Boolean,
    Function, RegExp, Math, JSON,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    Infinity, NaN, undefined, Buffer,
    window: {}, navigator: {},
    document: {
      // Cookie 必须在这里就设置好——fbeZ 初始化时会读取
      cookie: cookieStr || '',
    },
    location: {
      href: 'https://mms.pinduoduo.com/express/expressOnlineNew?from=orignal&msfrom=mms_sidenav',
    },
    screen: {}, history: {}, performance: {},
    localStorage: {}, sessionStorage: {},
    XMLHttpRequest: function() { this.readyState = 4; this.status = 200; },
    WebSocket: function() {},
    Worker: function() {},
    Image: function() {},
    EventTarget: function() {},
  };

  vm.createContext(sandbox);

  // 替换 init_cookie 为 no-op (cookie 已在上面的 document.cookie 预置)
  const modified = code.replace(/init_cookie\("[^"]*"\)/, '""');

  // 3. 加载 res.js (环境模拟 + webpack + fbeZ)
  vm.runInContext(modified, sandbox);

  // 4. 加载后补丁: Date.now 接管 + UA/location 修正 + cookie 锁定
  vm.runInContext(`
    // 接管 Date.now，确保 fbeZ 内部任何时间调用都用 PDD 服务端时间
    Date.now = function() { return ${serverTime}; };
    window.Date = Date;

    // 把 sandbox 全局 document 替换为 pdd.js 构建后的 window.document
    document = window.document;

    // 强制设定 UA 与 axios 请求头一致
    window.navigator.userAgent = ${JSON.stringify(UA)};

    // 锁定 cookie: 用 defineProperty getter 确保 fbeZ 怎么读都是完整值
    Object.defineProperty(document, 'cookie', {
      get: function() { return ${JSON.stringify(cookieStr || '')}; },
      set: function(v) {
        try { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(document), 'cookie').set.call(document, v); } catch(_) {}
      },
      configurable: true, enumerable: true,
    });

    // location 修正为寄件页面
    window.location.href = 'https://mms.pinduoduo.com/express/expressOnlineNew?from=orignal&msfrom=mms_sidenav';
  `, sandbox);

  // 5. 直接用真实 serverTime 生成 anti-content (绕过 _DateNow)
  return vm.runInContext(`
    (function() {
      var m = window.sj('fbeZ');
      var K = window.sj.n ? window.sj.n(m) : m;
      return new K.a({ serverTime: ${serverTime} }).messagePack();
    })()
  `, sandbox);
}

module.exports = { generateAntiContent };
