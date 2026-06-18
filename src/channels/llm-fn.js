/**
 * LLM 工具函数实现 — 将 LLM 函数调用映射到 pdd.js 业务逻辑
 */
const pdd = require('../pdd');
const db = require('../db');
const config = require('../config');

const sender = config.pdd.sender;

async function listPreparingOrders() {
  const data = await pdd.listPreparingOrders(1, 100);
  return (data.records || []).map(r => ({
    orderSn: r.orderSn,
    receiveName: (r.receiveName || '').replace(/\*/g, ''),
    receiveMobile: (r.receiveMobile || '').replace(/\*/g, ''),
    receiverProvince: r.receiverProvince || '',
    receiverCity: r.receiverCity || '',
    receiverDistrict: r.receiverDistrict || '',
    receiveAddress: (r.receiveAddress || '').replace(/\*/g, ''),
  }));
}

async function predictPrice(params) {
  const orders = await listPreparingOrders();
  const order = orders.find(o => o.orderSn === params.orderSn);
  if (!order) throw new Error('未找到订单 ' + params.orderSn);

  const price = await pdd.predictPrice({
    sender,
    orderSn: params.orderSn,
    receiverProvinceId: order.receiverProvinceId || '',
    receiverProvince: order.receiverProvince,
    receiverCityId: order.receiverCityId || '',
    receiverCity: order.receiverCity,
    receiverDistrictId: order.receiverDistrictId || '',
    receiverDistrict: order.receiverDistrict,
    shipCode: params.shipCode,
  });
  return { shipCode: params.shipCode, shipName: '', totalPriceStr: price.totalPriceStr };
}

async function predictAllPrices(params) {
  const orders = await listPreparingOrders();
  const order = orders.find(o => o.orderSn === params.orderSn);
  if (!order) throw new Error('未找到订单 ' + params.orderSn);

  const couriers = await pdd.listSupportCouriers();
  const results = [];
  for (const c of couriers) {
    try {
      const price = await pdd.predictPrice({
        sender, orderSn: params.orderSn,
        receiverProvinceId: order.receiverProvinceId || '',
        receiverProvince: order.receiverProvince,
        receiverCityId: order.receiverCityId || '',
        receiverCity: order.receiverCity,
        receiverDistrictId: order.receiverDistrictId || '',
        receiverDistrict: order.receiverDistrict,
        shipCode: c.shipCode, branchId: c.branchId || '',
      });
      results.push({ shipCode: c.shipCode, shipName: c.shipName, totalPriceStr: price.totalPriceStr, totalPrice: price.totalPrice });
    } catch (_) {}
  }
  results.sort((a, b) => (a.totalPrice || 999999) - (b.totalPrice || 999999));
  return { cheapest: results[0] || null, all: results };
}

async function createOrderAndQuery(params) {
  const addr = await pdd.extractAddress(params.addressText);
  if (!addr.consignee || addr.consignee.length < 2) addr.consignee += '女士';
  const order = await pdd.createManualOrder(addr);

  const couriers = await pdd.listSupportCouriers();
  const results = [];
  for (const c of couriers) {
    try {
      const price = await pdd.predictPrice({
        sender, orderSn: order.orderSn,
        receiverProvinceId: addr.provinceId, receiverProvince: addr.province,
        receiverCityId: addr.cityId, receiverCity: addr.city,
        receiverDistrictId: addr.districtId, receiverDistrict: addr.district,
        shipCode: c.shipCode, branchId: c.branchId || '',
      });
      results.push({ shipCode: c.shipCode, shipName: c.shipName, totalPriceStr: price.totalPriceStr, totalPrice: price.totalPrice });
    } catch (_) {}
  }
  results.sort((a, b) => (a.totalPrice || 999999) - (b.totalPrice || 999999));

  return {
    orderSn: order.orderSn,
    consignee: addr.consignee,
    phone: addr.phone,
    address: addr.province + addr.city + addr.district + ' ' + addr.detail,
    cheapest: results[0] || null,
    all: results,
  };
}

async function shipOrder(params) {
  const { orderSn, shipCode, predictPrice: predictPriceVal } = params;
  const result = await pdd.createShipment({
    sender,
    orderSn,
    goodsWeight: 1000,
    predictPrice: predictPriceVal || 0,
    courierInfo: { shipCode, shipName: '', deliveryModel: 2 },
  });
  return result;
}

async function listShippedOrders() {
  const data = await pdd.listShipmentRecords(1, 100);
  const cutoff = Date.now() - 48 * 3600 * 1000;
  return (data.records || [])
    .filter(r => r.receiptTime > cutoff)
    .map(r => ({
      shipName: r.shipName,
      waybillCode: r.waybillCode,
      receiverName: r.receiverName,
      totalPriceStr: r.realPriceStr || r.predictPriceStr || '',
    }));
}

async function cancelShipment(params) {
  await pdd.cancelShipment(params.deliverySn);
  return { success: true };
}

async function batchShip(params) {
  const orders = await listPreparingOrders();
  const result = await pdd.createShipmentBatch({
    sender,
    courierInfo: { shipCode: params.shipCode, shipName: '', deliveryModel: 2 },
    orders: orders.map(o => ({ orderSn: o.orderSn, predictPrice: 0, predictWeight: 1000 })),
  });
  let success = 0, fail = 0;
  (result.resultList || []).forEach(item => { if (item.success) success++; else fail++; });
  return { success, fail, total: orders.length };
}

async function deleteOrder(params) {
  await pdd.deleteManualOrder(params.orderSn);
  return { success: true, orderSn: params.orderSn };
}

async function deleteAllOrders() {
  const orders = await listPreparingOrders();
  let done = 0;
  for (const o of orders) {
    try { await pdd.deleteManualOrder(o.orderSn); done++; } catch (_) {}
  }
  return { success: true, deleted: done };
}

function help() {
  return `可用功能：

📦 寄件：回复收货地址即可下单
📋 查待寄件：查看待下单列表
🚚 查已寄出：查看最近寄出记录
💰 比价：查看各快递价格
❌ 取消：取消寄件

也支持口语化指令，如：
"把第一个待寄件寄了"
"用最便宜的快递"
"批量寄出所有"`;
}

// 注册到 LLM 模块
const { registerFunctions } = require('./llm');
registerFunctions({
  list_preparing_orders: listPreparingOrders,
  predict_all_prices: predictAllPrices,
  create_order_and_query: createOrderAndQuery,
  ship_order: shipOrder,
  list_shipped_orders: listShippedOrders,
  cancel_shipment: cancelShipment,
  batch_ship: batchShip,
  delete_order: deleteOrder,
  delete_all_orders: deleteAllOrders,
  help,
});

module.exports = { listPreparingOrders, predictAllPrices, createOrderAndQuery, shipOrder, listShippedOrders, cancelShipment, batchShip, deleteOrder, deleteAllOrders };
