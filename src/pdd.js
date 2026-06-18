/**
 * 拼多多商家版 API 客户端 (Web Cookie 模式)
 */

const axios = require('axios');
const config = require('./config');

// 代理支持：设置 PDD_HTTP_PROXY=http://host:port 启用
const proxyUrl = process.env.PDD_HTTP_PROXY || '';
let proxyAgent = null;
if (proxyUrl) {
  try { proxyAgent = new (require('https-proxy-agent').HttpsProxyAgent)(proxyUrl); } catch (_) {}
  console.log('[PDD] 使用代理:', proxyUrl);
}
const getProxyOption = () => proxyAgent ? { httpsAgent: proxyAgent } : {};

const BASE = config.pddBaseUrl || 'https://mms.pinduoduo.com';

let _db = null;
const getDb = () => { if (!_db) _db = require('./db'); return _db; };

// 通用请求
const pddRequest = async (method, path, body = {}, extraHeaders = {}) => {
  const url = BASE + path;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': BASE + '/',
    'Origin': BASE,
    ...extraHeaders,
  };
  const cookie = await getActiveCookie();
  if (cookie) headers['Cookie'] = cookie;

  // 寄件接口：浏览器内 fetch 发出 (PDD 自动注入 anti-content)
  if (path.includes('/online_delivery/receipt/create/online/batch')) {
    console.log('[PDD] 寄件请求通过浏览器 fetch (自动注入 anti-content)');
    const login = require('./login');
    const result = await login.shipOrderViaBrowser(url, body);
    if (result && !result.__error) {
      // 浏览器成功发出了请求。即使 PDD 返回业务错误（参数错误等）也算请求成功，直接透传
      if (result.success || (result.errorCode && result.errorCode !== 1002)) {
        return result;
      }
      // 1002 表示 anti-content 仍然有问题，需要 fallback
    }
    // 浏览器方案失败，fallback 到 VM 沙箱 + axios
    // 注意：不再重试 page.evaluate —— shipOrderViaBrowser 已经在浏览器中生成了
    // anti-content，如果它返回 1002 说明浏览器模块也被拒了，重试无意义。
    console.log('[PDD] 浏览器 fetch 失败, fallback VM 沙箱 + axios, result=', JSON.stringify(result).slice(0, 100));
    // 先同步浏览器最新 cookie 到 SQLite（浏览器 session 可能已刷新）
    try {
      const browserCookie = await login.getBrowserCookie();
      if (browserCookie && browserCookie.length > 20) {
        saveCookie(browserCookie, '', '');
        console.log('[PDD] 已同步浏览器 cookie 到 SQLite');
        // 同步后重读 cookie，确保 headers 中的 Cookie 是最新的
        headers['Cookie'] = await getActiveCookie();
      }
    } catch (_) {}
    try {
      const { generateAntiContent: vmGen } = require('./anti');
      const cookie = await getActiveCookie();
      const antiResult = await vmGen(cookie || '');
      let anti = null;
      if (antiResult && typeof antiResult === 'object' && antiResult.antiContent) {
        anti = antiResult.antiContent;
      } else if (typeof antiResult === 'string' && antiResult.length > 20) {
        anti = antiResult;
      }
      if (anti && anti.length > 20) {
        console.log('[PDD] VM anti-content len=' + anti.length);
        headers['anti-content'] = anti;
      } else {
        console.log('[PDD] anti-content 为空或太短');
      }
    } catch (e) {
      console.log('[PDD] anti-content 异常: ' + e.message);
    }
  }

  const resp = await axios({ method, url, data: body || {}, headers, timeout: 20000, ...getProxyOption() });
  const data = resp.data;

  // 调试：打印所有非成功的响应
  if (data && !data.success && !resp.status.toString().startsWith('2')) {
    console.log('[PDD] API响应异常:', JSON.stringify({status: resp.status, path, errCode: data.errorCode, errMsg: data.errorMsg}).slice(0, 200));
  }

  if (data && data.errorCode === 1002) {
    console.log('[PDD] anti-content 失效 (1002)');
  }

  if (data && typeof data === 'object' && data.errorCode && (
    data.errorCode === 40001 || data.errorCode === 40003 ||
    (data.errorMsg && (data.errorMsg.includes('登录') || data.errorMsg.includes('认证') || data.errorMsg.includes('过期') || data.errorMsg.includes('会话')))
  )) {
    throw new CookieExpiredError(data.errorMsg || 'Cookie 已过期');
  }
  return data;
};

class CookieExpiredError extends Error {
  constructor(msg) { super(msg); this.name = 'CookieExpiredError'; }
}

// Cookie 管理
const getActiveCookie = async () => {
  try { const row = getDb().getActiveCookie(); return row ? row.cookie_string : null; } catch (e) { return null; }
};
const saveCookie = (cookieString, mallId, mallName) => {
  getDb().saveCookie(cookieString, mallId, mallName);
};
const buildCookieString = (cookies) => {
  if (!Array.isArray(cookies)) return cookies;
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
};

// 测试 Cookie 有效性
const testCookie = async () => {
  try {
    const url = BASE + '/mallcenter/changeAccountInfo/accountSetting/accountInfo';
    const cookie = await getActiveCookie();
    const headers = {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
    };
    if (cookie) headers['Cookie'] = cookie;
    const resp = await axios.get(url, { headers, maxRedirects: 0, timeout: 10000, validateStatus: s => s < 400, ...getProxyOption() });
    return resp.status === 200 ? { valid: true } : { valid: false, error: 'Cookie 已过期' };
  } catch (e) {
    if (e.response && (e.response.status === 302 || e.response.status === 301)) {
      return { valid: false, error: 'Cookie 已过期' };
    }
    return { valid: false, error: e.message };
  }
};

// =========================================================
// 地址解析 — 官方 API
// =========================================================
const extractAddress = async (addressText) => {
  try {
    const resp = await pddRequest('POST', '/express_wbfrontend/kiana/mall/delivery/address/extract', {
      addressText,
    });
    if (resp && resp.success && resp.result) {
      const r = resp.result;
      let detail = r.detail || '';

      // 极端情况: 详细地址去掉省市区后太短 (<4个汉字)，拼多多拒收
      // 解决方案: 前面补上区/市名，如 "北辛街道" → "滕州市北辛街道"
      const pureDetail = detail
        .replace(r.province || '', '')
        .replace(r.city || '', '')
        .replace(r.district || '', '')
        .trim();
      if (pureDetail.length < 4 && r.district) {
        detail = r.district + pureDetail;
      }
      // 仍然不够，再加市名
      const stillPure = detail
        .replace(r.province || '', '')
        .replace(r.city || '', '')
        .replace(r.district || '', '')
        .trim();
      if (stillPure.length < 4 && r.city) {
        detail = r.city + stillPure;
      }

      return {
        consignee: r.consignee || '',
        phone: r.phone || '',
        province: r.province || '',
        city: r.city || '',
        district: r.district || '',
        detail,
        provinceId: r.provinceId || 0,
        cityId: r.cityId || 0,
        districtId: r.districtId || 0,
      };
    }
    throw new Error(resp?.errorMsg || '地址解析失败');
  } catch (e) {
    if (e.name === 'CookieExpiredError') throw e;
    throw new Error('地址解析失败: ' + e.message);
  }
};

// =========================================================
// 创建手工订单 — 官方 API (只下单不寄件)
// =========================================================
const createManualOrder = async (addr) => {
  try {
    const resp = await pddRequest('POST', '/express_wbfrontend/kiana/mall/delivery/settlement/create/manual/order', {
      goodsNum: addr.goodsNum || 1,
      goodsWeight: addr.goodsWeight || 1000,
      provinceCode: String(addr.provinceId),
      provinceName: addr.province,
      cityCode: String(addr.cityId),
      cityName: addr.city,
      districtCode: String(addr.districtId),
      districtName: addr.district,
      contactMobile: addr.phone,
      contactName: addr.consignee,
      addressDetail: addr.detail,
      address: [String(addr.provinceId), String(addr.cityId), String(addr.districtId)],
    });
    if (resp && resp.success && resp.result) {
      return { orderSn: resp.result.orderSn };
    }
    throw new Error(resp?.errorMsg || '创建订单失败');
  } catch (e) {
    if (e.name === 'CookieExpiredError') throw e;
    throw new Error('创建订单失败: ' + e.message);
  }
};

// 删除手工订单
const deleteManualOrder = async (orderSn) => {
  const resp = await pddRequest('POST', '/express_wbfrontend/kiana/mall/delivery/settlement/delete/manual/order', {
    manual_order_sn: orderSn,
  });
  return resp;
};

// =========================================================
// branchId 映射 — 默认网点 ID（仅当 listCourierBindV1 不可用时做 fallback）
// =========================================================
const BRANCH_ID_MAP = {
  YUNDA: 20251011000001,
  JTSD: 250820000005,
  YZDSBK: 260126000014,
  STO: 260128000020,
  YTO: 251028000001,
  ZTO: 251204000008,
  SF: 241125000003,
};

// 快递员信息映射 — 批量下单必填字段（仅当 listCourierBindV1 不可用时做 fallback）
const COURIER_INFO_MAP = {
  YUNDA:  { courierCode: 'yunda_default', branchCode: 'yunda_default', courierName: '待快递员上门取件', mobile: ' ', branchMallId: 0, promotionAmount: null },
  JTSD:   { courierCode: 'jt_shared',      branchCode: 'jt_shared',      courierName: '待快递员上门取件', mobile: ' ', branchMallId: 0, promotionAmount: null },
  YZDSBK: { courierCode: 'yzds_shared',     branchCode: 'yzds_shared',     courierName: '待快递员上门取件', mobile: ' ', branchMallId: 252431988, promotionAmount: 260 },
  STO:    { courierCode: 'sto_default',     branchCode: 'sto_default',     courierName: '待快递员上门取件', mobile: ' ', branchMallId: 0, promotionAmount: null },
  YTO:    { courierCode: 'yto_default',     branchCode: 'yto_default',     courierName: '待快递员上门取件', mobile: ' ', branchMallId: 0, promotionAmount: null },
  ZTO:    { courierCode: 'zto_default',     branchCode: 'zto_default',     courierName: '待快递员上门取件', mobile: ' ', branchMallId: 0, promotionAmount: null },
  SF:     { courierCode: 'sf_default',      branchCode: 'sf_default',      courierName: '待快递员上门取件', mobile: ' ', branchMallId: 772745737, promotionAmount: null },
};

const getBranchId = (shipCode) => BRANCH_ID_MAP[shipCode] || 0;
const getCourierInfo = (shipCode) => COURIER_INFO_MAP[shipCode] || { courierCode: 'unknown', branchCode: 'unknown', courierName: '待快递员上门取件', mobile: ' ' };

// =========================================================
// 支持的快递公司列表 (在线寄件)
// =========================================================
const listSupportCouriers = async () => {
  const resp = await pddRequest('POST', '/express_wbfrontend/online_delivery/courier/support_ship/list', {});
  if (resp && resp.success && resp.result) {
    return resp.result.map(c => ({
      shipId: c.shipId,
      shipCode: c.shipCode,
      shipName: c.shipName,
      shipLogoUrl: c.shipLogoUrl,
      branchId: getBranchId(c.shipCode),  // 从映射表获取
    }));
  }
  return [];
};

// 预估价格 — 新批量 API (支持多订单)
const predictPrice = async (params) => {
  try {
    const sender = params.sender;
    const orderSn = params.orderSn;  // 单个订单
    const resp = await pddRequest('POST', '/express_wbfrontend/kiana/mall/delivery/settlement/predict/price', {
      version: 'V3',
      senderProvinceId: String(sender.provinceId),
      senderProvince: sender.province,
      senderCityId: String(sender.cityId),
      senderCity: sender.city,
      senderDistrictId: String(sender.districtId),
      senderDistrict: sender.district,
      shipCode: params.shipCode,
      branchId: params.branchId || null,
      deliveryModel: 2,
      courierSupportOrderDeliveryType: null,
      goodsInfo: [{
        orderSn: orderSn,
        receiverProvinceId: String(params.receiverProvinceId),
        receiverProvince: params.receiverProvince,
        receiverCityId: String(params.receiverCityId),
        receiverCity: params.receiverCity,
        receiverDistrictId: String(params.receiverDistrictId),
        receiverDistrict: params.receiverDistrict,
        goodsNum: 1,
        orderDeliveryType: 0,
        weight: params.weight || 1000,
      }],
      reqSource: 'MD_MMS',
    });
    if (resp && resp.success && resp.result) {
      const r = resp.result;
      const detail = (r.priceDetail && r.priceDetail[0]) || {};
      return {
        totalPrice: r.totalPrice || detail.sumPrice || 0,
        totalPriceStr: r.totalPriceStr || detail.sumPriceStr || '0.00',
        // 阶梯定价: 再寄 needCount 单, 每单 nextStagePrice
        needCount: r.needCount || null,
        nextStagePriceStr: r.nextStageBasePriceStr || null,
      };
    }
    throw new Error(resp?.errorMsg || '报价失败');
  } catch (e) {
    if (e.name === 'CookieExpiredError') throw e;
    throw new Error('报价失败: ' + e.message);
  }
};

// 批量预估价格 (多个订单 + 同一快递)
const predictPriceBatch = async (params) => {
  try {
    const sender = params.sender;
    const goodsInfo = (params.orders || []).map(order => ({
      orderSn: order.orderSn,
      receiverProvinceId: String(order.receiverProvinceId),
      receiverProvince: order.receiverProvince,
      receiverCityId: String(order.receiverCityId),
      receiverCity: order.receiverCity,
      receiverDistrictId: String(order.receiverDistrictId),
      receiverDistrict: order.receiverDistrict,
      goodsNum: 1,
      orderDeliveryType: 0,
      weight: order.weight || 1000,
    }));

    const resp = await pddRequest('POST', '/express_wbfrontend/kiana/mall/delivery/settlement/predict/price', {
      version: 'V3',
      senderProvinceId: String(sender.provinceId),
      senderProvince: sender.province,
      senderCityId: String(sender.cityId),
      senderCity: sender.city,
      senderDistrictId: String(sender.districtId),
      senderDistrict: sender.district,
      shipCode: params.shipCode,
      branchId: params.branchId || '',
      deliveryModel: 2,
      courierSupportOrderDeliveryType: null,
      goodsInfo,
      reqSource: 'MD_MMS',
    });
    if (resp && resp.success && resp.result) {
      return resp.result;
    }
    throw new Error(resp?.errorMsg || '批量报价失败');
  } catch (e) {
    if (e.name === 'CookieExpiredError') throw e;
    throw new Error('批量报价失败: ' + e.message);
  }
};

// 获取用户绑定快递的真实信息（courierCode, branchCode, branchMallId, promotionAmount 等）
const listCourierBindV1 = async (addressId) => {
  try {
    const resp = await pddRequest('POST', '/express_wbfrontend/online_delivery/courier/list/bindV1', { addressId: addressId || 0 });
    if (resp && resp.success && Array.isArray(resp.result)) return resp.result;
    return [];
  } catch (e) { return []; }
};

// 批量创建寄件 (需 anti-content 请求头)
const createShipmentBatch = async (params) => {
  try {
    const sender = params.sender;
    const courier = params.courierInfo;
    const orders = params.orders || [{
      orderSn: params.orderSn,
      predictPrice: params.predictPrice || 0,
      predictWeight: params.goodsWeight || 1000,
    }];

    // 获取该快递在用户账号下的真实配置（覆盖硬编码的默认值）
    let realCourier = null;
    try {
      const bindList = await listCourierBindV1(sender.addressId);
      realCourier = bindList.find(c => c.shipCode === courier.shipCode);
    } catch (_) {}

    const body = {
      senderAddress: {
        addressId: sender.addressId || 0,
        contactName: sender.name,
        contactMobile: sender.mobile,
        contactTelephone: '',
        countryCode: '156',
        countryName: '中国',
        provinceCode: String(sender.provinceId),
        provinceName: sender.province,
        cityCode: String(sender.cityId),
        cityName: sender.city,
        districtCode: String(sender.districtId),
        districtName: sender.district,
        townCode: '',
        townName: '',
        addressDetail: sender.addressDetail || '',
        postCode: '',
        defaultFlag: true,
      },
      courierInfo: {
        courierCode: realCourier?.courierCode || courier.courierCode || getCourierInfo(courier.shipCode).courierCode,
        courierName: realCourier?.courierName || courier.courierName || getCourierInfo(courier.shipCode).courierName,
        shipCode: courier.shipCode,
        shipName: courier.shipName,
        shipLogo: realCourier?.shipLogo || courier.shipLogoUrl || courier.shipLogo || null,
        mobile: realCourier?.mobile || courier.mobile || getCourierInfo(courier.shipCode).mobile,
        branchCode: realCourier?.branchCode || courier.branchCode || getCourierInfo(courier.shipCode).branchCode,
        branchName: null,
        branchCountryCode: null,
        branchCountryName: null,
        branchProvinceCode: null,
        branchProvinceName: null,
        branchCityCode: null,
        branchCityName: null,
        branchDistrictCode: null,
        branchDistrictName: null,
        branchTownCode: null,
        branchTownName: null,
        branchDetail: null,
        canAutoDistribute: null,
        canPrintRemark: null,
        branchId: realCourier?.branchId || courier.branchId || courier.courierId || 0,
        courierId: realCourier?.courierId || courier.courierId || courier.branchId || 0,
        branchMallId: realCourier?.branchMallId || courier.branchMallId || getCourierInfo(courier.shipCode).branchMallId || 0,
        branchMallName: null,
        settlementFlag: true,
        deliveryModel: courier.deliveryModel || realCourier?.deliveryModel || 2,
        supportOrderDeliveryType: null,
        promotionAmount: realCourier?.promotionAmount !== undefined && realCourier?.promotionAmount !== null
          ? realCourier.promotionAmount
          : (courier.promotionAmount !== undefined ? courier.promotionAmount : getCourierInfo(courier.shipCode).promotionAmount),
        pickDesc: realCourier?.pickDesc || courier.pickDesc || null,
      },
      orders: orders.map(o => ({
        orderSn: o.orderSn,
        predictPrice: o.predictPrice || 0,
        predictWeight: o.predictWeight || 1000,
        predictSubsidyPrice: null,
        subsidyId: null,
        orderDeliveryType: 0,
      })),
      showGoodInfo: false,
      checkAddress: true,
      confirmed: true,
      showRemark: false,
      channelType: 8,
    };

    const resp = await pddRequest('POST', '/express_wbfrontend/online_delivery/receipt/create/online/batch', body);

    if (resp && resp.success && resp.result) {
      return resp.result;
    }
    console.error('[PDD] createShipment FAILED:', JSON.stringify(resp).substring(0, 300));
    throw new Error(resp?.errorMsg || resp?.error_msg || '寄件失败');
  } catch (e) {
    if (e.name === 'CookieExpiredError') throw e;
    throw new Error('寄件失败: ' + e.message);
  }
};

// 单笔寄件 (封装批量接口)
const createShipment = async (params) => {
  const courier = params.courierInfo;
  return await createShipmentBatch({
    sender: params.sender,
    orderSn: params.orderSn,
    goodsWeight: params.goodsWeight || 1000,
    predictPrice: courier.price?.totalPrice || params.predictPrice || 0,
    courierInfo: courier,
  });
};

// 取消寄件
const cancelShipment = async (deliverySn) => {
  try {
    const resp = await pddRequest('POST', '/express_wbfrontend/online_delivery/receipt/cancel', {
      deliveryReceiptSn: deliverySn,
      cancelReasonType: 500,
    });
    if (resp && resp.success) return resp.result;
    throw new Error(resp?.errorMsg || '取消失败');
  } catch (e) {
    if (e.name === 'CookieExpiredError') throw e;
    throw new Error('取消失败: ' + e.message);
  }
};

// =========================================================
// 查询接口
// =========================================================

// 待寄件手工订单列表
const listPreparingOrders = async (page = 1, size = 30) => {
  const resp = await pddRequest('POST', '/express_wbfrontend/online_delivery/receipt/list/preparing', {
    page, size, orderType: -1, orderSn: '', needPage: true,
  });
  if (resp && resp.success && resp.result) {
    return { records: resp.result.resultList || [], total: resp.result.totalCount };
  }
  return { records: [], total: 0 };
};

// 已寄件记录列表
const listShipmentRecords = async (page = 1, size = 100) => {
  const resp = await pddRequest('POST', '/express_wbfrontend/online_delivery/receipt/list/delivery', {
    page, size, newVersionFlag: 1,
  });
  if (resp && resp.success && resp.result) {
    return {
      records: (resp.result.resultList || []).map(item => ({
        deliverySn: item.deliveryReceiptSn,
        orderSn: item.orderSn,
        waybillCode: item.trackingNumber,
        shipName: item.shipName,
        shipCode: item.shipCode,
        courierName: item.courierName,
        statusDesc: item.statusDesc,
        showStatusDesc: item.showStatusDesc,
        receiverName: item.receiveName,
        receiverMobile: item.receiveMobile,
        receiverProvince: item.receiveProvinceName,
        receiverCity: item.receiveCityName,
        receiverDistrict: item.receiveDistrictName,
        receiverAddress: item.receiveAddress,
        predictPriceStr: item.predictPriceStr,
        realPriceStr: item.realPriceStr,
        receiptTime: item.receiptTime,
        cancelFlag: item.cancelFlag,
      })),
      total: resp.result.totalCount,
    };
  }
  return { records: [], total: 0 };
};

// =========================================================
// 批量寄件 / 一键寄件
// =========================================================

const sendFromAddress = async (addressText, courierCode = null, senderParam = null) => {
  const sender = senderParam || config.pdd.sender;
  const addr = await extractAddress(addressText);
  if (addr.consignee && addr.consignee.length < 2) addr.consignee += '女士';
  const order = await createManualOrder(addr);
  const couriers = await listSupportCouriers();
  let selected = courierCode
    ? couriers.find(c => c.shipCode === courierCode || c.courierCode === courierCode)
    : couriers[0];
  if (!selected) selected = couriers[0];

  const price = await predictPrice({
    sender, orderSn: order.orderSn,
    receiverProvinceId: addr.provinceId, receiverProvince: addr.province,
    receiverCityId: addr.cityId, receiverCity: addr.city,
    receiverDistrictId: addr.districtId, receiverDistrict: addr.district,
    branchId: selected.branchId || '', shipCode: selected.shipCode,
  });

  const result = await createShipment({
    sender, orderSn: order.orderSn,
    courierInfo: {
      shipId: selected.shipId, shipCode: selected.shipCode,
      shipName: selected.shipName, deliveryModel: 2,
    },
  });

  return {
    manualSn: order.orderSn,
    deliverySn: result.resultList?.[0]?.deliveryReceiptSn || result.deliverySn,
    waybillCode: result.resultList?.[0]?.waybillCode || result.trackingNumber,
    receiver: addr, courier: selected, price,
  };
};

module.exports = {
  pddRequest, CookieExpiredError,
  getActiveCookie, saveCookie, buildCookieString, testCookie,
  extractAddress, createManualOrder, deleteManualOrder,
  listSupportCouriers, predictPrice, predictPriceBatch, createShipment, createShipmentBatch, cancelShipment,
  listPreparingOrders, listShipmentRecords, listCourierBindV1,
  sendFromAddress,
};
