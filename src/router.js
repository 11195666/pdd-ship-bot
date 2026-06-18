const pdd = require('./pdd');
// send 函数由渠道层注入
const db = require('./db');
const config = require('./config');

const ts = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

function isSessionExpired(session) {
  if (!session) return true;
  return Date.now() - new Date(session.updated_at + 'Z').getTime() > SESSION_TIMEOUT_MS;
}

const handleMessage = async (msg, send) => {
  const user = msg.from;
  const content = (msg.content || '').trim();
  let session = db.getSession(user);

  if (msg.MsgType && msg.MsgType !== 'text') return null;
  if (!content) return null;

  if (session && isSessionExpired(session)) {
    const stateNames = {
      confirm_name: '收件人姓名修正',
      confirm_address: '地址确认',
      only_order: '仅创建订单',
      choosing_courier: '快递选择',
      confirm: '寄件确认',
      batch_choosing: '批量寄件',
    };
    const name = stateNames[session.state] || session.state;
    await send(user, '「' + name + '」已超时(10分钟)，请重新开始。');
    db.clearSession(user);
    session = null;
  }

  // ── 会话中支持退出/菜单 ──
  // 注意: 数字不能在此拦截，choosing_courier 等状态下数字用于选择
  if (session && ['取消','退出','菜单','menu'].includes(content)) {
    db.clearSession(user);
    return buildMainMenu();
  }

  // ── 状态机 ──
  if (session?.state === 'confirm_name') return handleNameFix(user, session, content);
  if (session?.state === 'confirm_address') return handleAddressConfirm(user, session, content);
  if (session?.state === 'only_order') return handleOnlyOrderConfirm(user, session, content);
  if (session?.state === 'choosing_courier') return handleCourierChoice(user, session, content);
  if (session?.state === 'confirm') return handleFinalConfirm(user, session, content);
  if (session?.state === 'batch_choosing') return handleBatchChoice(user, session, content);

  // ── 全局命令 ──
  if (['帮助','help','?','？','菜单','menu','功能','首页','hi','hello','你好','5'].includes(content)) { db.clearSession(user); return buildMainMenu(); }
  if (['寄件','下单','发货','新建寄件','开始寄件','1'].includes(content)) { db.clearSession(user); return buildShippingGuide(); }
  if (content === '取消' || content === '退出') { db.clearSession(user); return buildMainMenu(); }
  if (content === 'Cookie' || content === 'cookie' || content === '4') return handleCookieStatus();
  if (['查待下单','待下单','待寄件','2'].includes(content)) return await handlePreparing(user);
  if (['查已寄出','已寄出','已寄件','3'].includes(content)) return await handleShipped(user);

  // 删除待下单: "删除 1" / "删除 1,2" / "全部删除"
  if (content.startsWith('删除') || content === '全部删除') return await handleDeleteOrder(user, content);
  // 寄出指定单子: "寄出 1" / "寄出 1,2"
  if (content.startsWith('寄出')) return await handleShipFromPreparing(user, content);
  // 取消已寄件: "取消 OD..."
  if (content.startsWith('取消 ')) return await handleCancelShipment(user, content);

  if (['地址','发件地址'].includes(content)) return handleSenderAddresses(user);
  const addrMatch = content.match(/^地址\s+(\d+)$/);
  if (addrMatch) return await handleSetSenderAddress(user, parseInt(addrMatch[1]));
  if (content === '批量寄件') return await handleBatchShipStart(user);

  // 地址识别
  if (content.length > 10 && (
    content.includes('省') || content.includes('市') || content.includes('区') ||
    content.includes('手机') || content.includes('电话') || content.includes('地址') || content.includes('收货') ||
    /1[3-9]\d{9}/.test(content)
  )) return await parseAndConfirmAddress(user, content);

  if (content.length <= 3 && /^\d+$/.test(content)) {
    return { type: 'text', content: '当前没有待选择的项目。回复 1 寄件，5 菜单。' };
  }
  return buildMainMenu();
};

// ═══════════════════════════════════════ 菜单 ═══════════════════════════════════════

function buildMainMenu() {
  return { type: 'text', content: [
    '拼多多寄件助手',
    '',
    '1. 寄件下单',
    '2. 查待下单',
    '3. 查已寄出',
    '4. 登录状态',
    '5. 帮助',
    '',
    '发送收件人地址可直接寄件:',
    '张三 13812345678 广东省广州市天河区XX路XX号',
    '',
    '发送「批量寄件」一键寄出多单。',
    '回复数字选择功能。',
  ].join('\n') };
}

function buildShippingGuide() {
  return { type: 'text', content: '发送收件人信息: 张三 13812345678 广东省广州市天河区XX路XX号\n\n回复「取消」退出。' };
}

// ═══════════════════════════════════════ 查单 ═══════════════════════════════════════

async function handlePreparing(user) {
  try {
    const data = await pdd.listPreparingOrders(1, 100);
    const records = data.records || [];
    if (!records.length) return { type: 'text', content: '暂无待下单订单。\n\n回复 1 寄件。' };

    const lines = ['待下单 (' + data.total + '条):', ''];
    records.forEach((r, i) => {
      const receiver = (r.receiveName || '?').replace(/\*/g, '');
      const addr = [r.receiverProvince, r.receiverCity, r.receiverDistrict].filter(Boolean).join('');
      lines.push((i+1) + '. ' + receiver + ' ' + addr);
      lines.push('   ' + r.orderSn);
    });
    lines.push('');
    lines.push('回复「寄出 1」寄出第1个，「寄出 1,2」寄出多个，支持选快递。');
    lines.push('回复「批量寄件」一键寄所有。');
    lines.push('回复「删除 1」删除第1个，「删除 1,2」删除多个，「全部删除」清空。');
    return { type: 'text', content: lines.join('\n') };
  } catch (e) {
    return { type: 'text', content: '查询失败: ' + e.message };
  }
}

async function handleShipped(user) {
  try {
    const data = await pdd.listShipmentRecords(1, 100);
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const recent = (data.records || []).filter(r => r.receiptTime > cutoff);
    if (!recent.length) return { type: 'text', content: '48小时内暂无已寄件。回复 1 寄件。' };

    const lines = ['48小时内已寄件 (' + recent.length + '条):', ''];
    recent.forEach((r, i) => {
      const receiver = (r.receiverName || '?').replace(/\*/g, '');
      const addr = [r.receiverProvince, r.receiverCity, r.receiverDistrict].filter(Boolean).join('');
      const price = r.realPriceStr || r.predictPriceStr || '';
      const status = r.showStatusDesc || r.statusDesc || '';
      lines.push((i+1) + '. ' + r.shipName + ' ' + (r.waybillCode||'?') + ' ' + price + '元' + (status ? ' [' + status + ']' : ''));
      lines.push('   ' + receiver + ' ' + addr);
    });
    return { type: 'text', content: lines.join('\n') };
  } catch (e) {
    return { type: 'text', content: '查询失败: ' + e.message };
  }
}

// ═══════════════════════════════════════ 删除待下单 ═══════════════════════════════════════

async function handleDeleteOrder(user, content) {
  try {
    const data = await pdd.listPreparingOrders(1, 100);
    const records = data.records || [];
    if (!records.length) return { type: 'text', content: '没有待下单订单可删除。' };

    // 全部删除
    if (content === '全部删除') {
      let done = 0;
      for (const r of records) {
        try { await pdd.deleteManualOrder(r.orderSn); done++; } catch (_) {}
      }
      return { type: 'text', content: '已删除 ' + done + ' 个订单。' };
    }

    // 删除指定编号: "删除 1" 或 "删除 1,2,3"
    const nums = content.replace('删除', '').trim();
    const indices = nums.split(/[,，\s]+/).map(n => parseInt(n) - 1).filter(n => n >= 0 && n < records.length);
    if (!indices.length) return { type: 'text', content: '格式: "删除 1" 或 "删除 1,2" 或 "全部删除"' };

    let done = 0;
    for (const idx of indices) {
      try { await pdd.deleteManualOrder(records[idx].orderSn); done++; } catch (_) {}
    }
    return { type: 'text', content: '已删除 ' + done + ' 个订单。回复 2 刷新待下单。' };
  } catch (e) {
    return { type: 'text', content: '删除失败: ' + e.message };
  }
}

// ═══════════════════════════════════════ 取消寄件 ═══════════════════════════════════════

async function handleCancelShipment(user, content) {
  const keyword = content.replace('取消 ', '').trim();
  const preparing = await pdd.listPreparingOrders(1, 50).catch(() => ({ records: [] }));
  const pm = preparing.records.find(r => r.orderSn === keyword || r.orderSn.endsWith(keyword));
  if (pm) {
    try { await pdd.deleteManualOrder(pm.orderSn); return { type: 'text', content: '已取消: ' + pm.orderSn }; }
    catch (e) { return { type: 'text', content: '取消失败: ' + e.message }; }
  }
  const shipped = await pdd.listShipmentRecords(1, 100).catch(() => ({ records: [] }));
  const sm = shipped.records.find(r => r.deliverySn === keyword || r.waybillCode === keyword);
  if (sm) {
    try { await pdd.cancelShipment(sm.deliverySn); return { type: 'text', content: '已取消: ' + sm.waybillCode + ' ' + sm.shipName }; }
    catch (e) { return { type: 'text', content: '取消失败: ' + e.message }; }
  }
  return { type: 'text', content: '未找到 "' + keyword + '"' };
}

// ═══════════════════════════════════════ 其他 ═══════════════════════════════════════

function handleCookieStatus() {
  const active = db.getActiveCookie();
  if (!active) return { type: 'text', content: '登录状态: 无效\n系统将自动登录，请稍后查看。' };
  const updated = new Date(active.updated_at.replace(' ', 'T'));
  const diffMs = Date.now() - updated.getTime();
  const hours = Math.max(0, Math.floor(diffMs / 3600000));
  const mins = Math.floor((diffMs % 3600000) / 60000);
  return { type: 'text', content: '登录状态: 有效\n已在线: ' + hours + '小时' + mins + '分钟\n更新时间: ' + (active.updated_at || '') };
}

function handleSenderAddresses(user) {
  const senders = config.pdd.senders || [];
  if (!senders.length && config.pdd.sender?.name) {
    const s = config.pdd.sender;
    return { type: 'text', content: '发件地址: ' + s.name + ' ' + s.mobile + '\n' + s.province + s.city + s.district + ' ' + s.addressDetail };
  }
  if (!senders.length) return { type: 'text', content: '未配置发件地址。' };
  const session = db.getSession(user);
  const current = session?.context?.senderIndex ?? 0;
  const lines = senders.map((s, i) => (i === current ? '✅ ' : '  ') + (i+1) + '. ' + s.name + ' ' + s.mobile);
  return { type: 'text', content: '发件地址 (回复"地址 N"切换):\n' + lines.join('\n') };
}

async function handleSetSenderAddress(user, index) {
  const senders = config.pdd.senders || [];
  const list = senders.length ? senders : (config.pdd.sender?.name ? [config.pdd.sender] : []);
  if (index < 1 || index > list.length) return { type: 'text', content: '地址编号 1-' + list.length };
  const chosen = list[index - 1];
  const session = db.getSession(user) || { state: 'idle', context: {} };
  session.context = session.context || {};
  session.context.senderIndex = index - 1;
  session.context.senderAddressId = chosen.addressId;
  session.context.sender = chosen;
  db.setSession(user, session.state || 'idle', session.context);
  return { type: 'text', content: '已切换到: ' + chosen.name + ' ' + chosen.province + chosen.city + chosen.district };
}

function getSender(session) {
  if (session?.context?.sender) return session.context.sender;
  const senders = config.pdd.senders || [];
  if (senders.length > 0) { const idx = session?.context?.senderIndex || 0; return senders[idx] || senders[0]; }
  return config.pdd.sender;
}

// ═══════════════════════════════════════ 状态处理 ═══════════════════════════════════════

async function handleNameFix(user, session, content) {
  const ctx = session.context || {};
  const rawName = (ctx.rawName || '').trim();
  if (content === '1') return await afterNameFixed(user, ctx, rawName + '女士');
  if (content === '2') return await afterNameFixed(user, ctx, rawName + '先生');
  if (content === '3') return await afterNameFixed(user, ctx, rawName + rawName);
  if (content.startsWith('4') || content.startsWith('自定义')) {
    let custom = content.replace(/^4\s*/, '').replace(/^自定义\s*/, '').trim();
    if (!custom || custom.length < 2) return { type: 'text', content: '请回复"4 全名"。' };
    return await afterNameFixed(user, ctx, custom);
  }
  if (content.length >= 2 && content.length <= 6 && !/[0-9]/.test(content)) return await afterNameFixed(user, ctx, content);
  return { type: 'text', content: '回复 1-3 选择，或"4 全名"。\n回复「取消」退出。(10分钟超时)' };
}

async function handleOnlyOrderConfirm(user, session, content) {
  if (['是','y','yes','1','确认','ok'].includes(content)) {
    try {
      const addr = session.context.addr;
      const order = await pdd.createManualOrder(addr);
      db.clearSession(user);
      return { type: 'text', content: '手工订单已创建\n订单号: ' + order.orderSn + '\n\n收件人: ' + addr.consignee + '\n手机: ' + addr.phone + '\n地址: ' + addr.province + addr.city + addr.district + ' ' + addr.detail + '\n\n回复「批量寄件」可批量寄出。' };
    } catch (e) { db.clearSession(user); return { type: 'text', content: '创建失败: ' + e.message }; }
  }
  if (['否','n','no','0'].includes(content)) { db.clearSession(user); return buildMainMenu(); }
  return { type: 'text', content: '回复"是"确认创建。回复「取消」退出。(10分钟超时)' };
}

async function handleCourierChoice(user, session, content) {
  const couriers = session.context?.couriers || [];
  if (!couriers.length) return { type: 'text', content: '暂无快递信息，请重新开始。' };

  // 确认或默认 → 选最便宜的
  if (['确认','默认','是','y','yes','ok'].includes(content)) {
    const cheapest = couriers.reduce((a, b) => (a.price?.totalPrice || 999999) <= (b.price?.totalPrice || 999999) ? a : b);
    return await confirmAndShip(user, session.context, cheapest);
  }

  const index = parseInt(content) - 1;
  if (isNaN(index) || index < 0 || index >= couriers.length) {
    return { type: 'text', content: '请输入 1-' + couriers.length + ' 选择快递，或回复「确认」选最低价。' };
  }
  return await confirmAndShip(user, session.context, couriers[index]);
}

async function handleFinalConfirm(user, session, content) {
  if (['是','y','yes','1','确认','ok'].includes(content)) return await doShip(user, session.context);
  const couriers = session.context?.couriers || [];
  db.setSession(user, 'choosing_courier', { ...session.context, couriers });
  let lines = ['重新选择快递:', ''];
  couriers.forEach((c, i) => {
    let line = (i+1) + '. ' + c.shipName + ' — ' + c.price.totalPriceStr + '元';
    if (c.price.needCount) line += ' | 再寄' + c.price.needCount + '单 ' + c.price.nextStagePriceStr + '元/单';
    lines.push(line);
  });
  await send(user, lines.join('\n'));
  return null;
}

// ═══════════════════════════════════════ 批量寄件 ═══════════════════════════════════════

async function handleBatchShipStart(user) {
  try {
    const data = await pdd.listPreparingOrders(1, 100);
    const records = data.records || [];
    if (!records.length) return { type: 'text', content: '暂无待下单订单。回复 1 开始创建。' };
    const couriers = await pdd.listSupportCouriers().catch(() => []);
    db.setSession(user, 'batch_choosing', { preparingOrders: records, couriers });
    let msg = '批量寄件 — 选择快递\n\n';
    couriers.forEach((c, i) => { msg += (i+1) + '. ' + c.shipName + '\n'; });
    msg += '\n待寄出 (' + records.length + '个):';
    records.forEach((r, i) => {
      const receiver = (r.receiveName || '?').replace(/\*/g, '');
      const addr = [r.receiverProvince, r.receiverCity, r.receiverDistrict].filter(Boolean).join('');
      msg += '\n  ' + (i+1) + '. ' + receiver + ' ' + addr;
    });
    msg += '\n\n回复快递编号批量寄出。\n回复「取消」退出。(10分钟超时)';
    await send(user, msg);
    return null;
  } catch (e) { return { type: 'text', content: '查询失败: ' + e.message }; }
}

async function handleBatchChoice(user, session, content) {
  if (content === '取消' || content === '退出') { db.clearSession(user); return buildMainMenu(); }
  const couriers = session.context?.couriers || [];
  const orders = session.context?.preparingOrders || [];
  const index = parseInt(content) - 1;
  if (isNaN(index) || index < 0 || index >= couriers.length) return { type: 'text', content: '请输入 1-' + couriers.length + ' 选择。' };
  const chosen = couriers[index];
  const sender = getSender({ context: {} });
  db.clearSession(user);

  try {
    const result = await pdd.createShipmentBatch({
      sender,
      courierInfo: { shipCode: chosen.shipCode, shipName: chosen.shipName, branchId: chosen.branchId || 0, courierId: chosen.branchId || 0, deliveryModel: 2 },
      orders: orders.map(o => ({ orderSn: o.orderSn, predictPrice: o.predictPrice || 0, predictWeight: o.goodsInfo?.goodsWeight || 1000 })),
    });
    let success = 0, fail = 0;
    (result.resultList || []).forEach(item => {
      if (item.success) {
        success++;
        db.createShipment({ manual_sn: item.orderSn, delivery_sn: item.deliveryReceiptSn || '', waybill_code: item.waybillCode || '', receiver_name: '', receiver_mobile: '', receiver_province: '', receiver_city: '', receiver_district: '', courier_name: chosen.shipName, courier_code: chosen.shipCode, ship_code: chosen.shipCode, price: 0, price_str: '', status: 'shipped', wechat_user: user });
      } else { fail++; }
    });
    return { type: 'text', content: '批量寄件完成\n快递: ' + chosen.shipName + '\n成功: ' + success + ' 单\n失败: ' + fail + ' 单\n\n回复 3 查看已寄出。' };
  } catch (e) { return { type: 'text', content: '批量寄件失败: ' + e.message }; }
}

// ═══════════════════════════════════════ 寄件流程 ═══════════════════════════════════════

async function parseAndConfirmAddress(user, addressText) {
  try {
    const addr = await pdd.extractAddress(addressText);
    const warnings = [];
    let needNameFix = false;
    if (!addr.consignee || addr.consignee.length < 2) needNameFix = true;
    if (!addr.phone || addr.phone.length < 11) warnings.push('未识别到手机号');
    if (!addr.province || !addr.city) warnings.push('省市识别可能不完整');

    if (needNameFix) {
      const rawName = addr.consignee || '';
      db.setSession(user, 'confirm_name', { addressText, addr, rawName, warnings });
      await send(user, '收件人只有一个字:\n\n原始: "' + (rawName||'(空)') + '"\n手机: ' + (addr.phone||'未识别') + '\n地址: ' + addr.province + addr.city + addr.district + ' ' + addr.detail + '\n\n1. ' + rawName + '女士\n2. ' + rawName + '先生\n3. ' + rawName + rawName + '\n4. 自定义 (4 全名)\n\n回复「取消」退出。(10分钟超时)');
      return null;
    }

    db.setSession(user, 'confirm_address', { addressText, addr, warnings });
    let msg = '地址解析成功\n\n收件人: ' + addr.consignee + '\n手机: ' + (addr.phone||'未识别') + '\n地址: ' + addr.province + addr.city + addr.district + '\n详细: ' + addr.detail;
    if (warnings.length) msg += '\n\n' + warnings.join('\n');
    msg += '\n\n请问需要做什么？\n1. 寄件下单\n2. 仅创建订单(后续批量寄)\n3. 查看所有快递报价\n(10分钟超时)';
    await send(user, msg);
    return null;
  } catch (e) {
    console.error(`[${ts()}] 解析失败: ${e.message}`);
    db.clearSession(user);
    if (e.name === 'CookieExpiredError') return { type: 'text', content: '登录已过期。' };
    return { type: 'text', content: '解析失败: ' + e.message + '\n\n格式: 张三 13812345678 广东省广州市天河区XX路XX号' };
  }
}

async function handleAddressConfirm(user, session, content) {
  if (content === '1' || content === '寄件下单' || content === '寄件') return await afterAddressConfirmed(user, session.context);
  if (content === '2' || content === '仅创建订单' || content === '只下单') {
    db.setSession(user, 'only_order', session.context);
    const addr = session.context.addr;
    await send(user, '仅创建手工订单(不寄件)\n\n收件人: ' + addr.consignee + '\n手机: ' + (addr.phone||'未识别') + '\n地址: ' + addr.province + addr.city + addr.district + ' ' + addr.detail + '\n\n回复"是"确认创建。\n回复「取消」退出。(10分钟超时)');
    return null;
  }
  if (content === '3' || content === '查看报价' || content === '查报价') return await showPricesOnly(user, session.context);
  if (['是','y','yes','确认','ok'].includes(content)) return await afterAddressConfirmed(user, session.context);
  if (['否','n','no','0','取消'].includes(content)) { db.clearSession(user); return buildMainMenu(); }
  if (content.length > 10 && (content.includes('省') || content.includes('市') || /1[3-9]\d{9}/.test(content))) return await parseAndConfirmAddress(user, content);
  return { type: 'text', content: '回复数字:\n1. 寄件下单\n2. 仅创建订单\n3. 查看报价\n(10分钟超时)' };
}

async function afterNameFixed(user, ctx, fixedName) {
  const addr = { ...ctx.addr, consignee: fixedName };
  db.setSession(user, 'confirm_address', { addressText: ctx.addressText, addr, warnings: ctx.warnings });
  await send(user, '收件人已更新: ' + fixedName + '\n手机: ' + (addr.phone||'未识别') + '\n地址: ' + addr.province + addr.city + addr.district + '\n详细: ' + addr.detail + '\n\n1. 寄件下单\n2. 仅创建订单\n3. 查看报价\n(10分钟超时)');
  return null;
}

// ═══════════════════════════════════════ 从待寄件选单寄出 ═══════════════════════════════════════

async function handleShipFromPreparing(user, content) {
  try {
    const data = await pdd.listPreparingOrders(1, 100);
    const records = data.records || [];
    if (!records.length) return { type: 'text', content: '没有待下单订单。' };

    const nums = content.replace('寄出', '').trim();
    const indices = nums.split(/[,，\s]+/).map(n => parseInt(n) - 1).filter(n => n >= 0 && n < records.length);
    if (!indices.length) return { type: 'text', content: '格式: "寄出 1" 或 "寄出 1,2"' };

    const selected = indices.map(i => records[i]);
    const first = selected[0];

    const ctx = {
      addr: {
        consignee: (first.receiveName || '').replace(/\*/g, ''),
        phone: (first.receiveMobile || '').replace(/\*/g, ''),
        province: first.receiverProvince || '',
        city: first.receiverCity || '',
        district: first.receiverDistrict || '',
        detail: (first.receiveAddress || '').replace(/\*/g, ''),
        provinceId: first.receiverProvinceId || 0,
        cityId: first.receiverCityId || 0,
        districtId: first.receiverDistrictId || 0,
      },
      orderSn: first.orderSn,
      selectedOrders: selected.map(o => ({
        orderSn: o.orderSn,
        receiverProvinceId: o.receiverProvinceId, receiverProvince: o.receiverProvince,
        receiverCityId: o.receiverCityId, receiverCity: o.receiverCity,
        receiverDistrictId: o.receiverDistrictId, receiverDistrict: o.receiverDistrict,
        goodsWeight: o.goodsInfo?.goodsWeight || 1000,
        predictPrice: o.predictPrice || 0,
      })),
    };

    return await showPricesOnly(user, ctx);
  } catch (e) {
    return { type: 'text', content: '查询失败: ' + e.message };
  }
}

// ═══════════════════════════════════════ 报价流程 ═══════════════════════════════════════

async function showPricesOnly(user, ctx) {
  try {
    const addr = ctx.addr;
    // 已有 orderSn（从待寄件列表直接寄出）则不创建新订单
    let orderSn = ctx.orderSn;
    if (!orderSn) {
      const order = await pdd.createManualOrder(addr);
      orderSn = order.orderSn;
    }
    const couriers = await pdd.listSupportCouriers();

    const couriersWithPrice = await Promise.all(
      couriers.slice(0, 7).map(async (c) => {
        try {
          const sender = getSender({ context: {} });
          const price = await pdd.predictPrice({
            sender, orderSn,
            receiverProvinceId: addr.provinceId, receiverProvince: addr.province,
            receiverCityId: addr.cityId, receiverCity: addr.city,
            receiverDistrictId: addr.districtId, receiverDistrict: addr.district,
            shipCode: c.shipCode, branchId: c.branchId,
          });
          return { ...c, price };
        } catch (e) { return { ...c, price: null }; }
      })
    );

    const valid = couriersWithPrice.filter(c => c.price);
    if (!valid.length) throw new Error('所有快递报价失败');

    db.setSession(user, 'choosing_courier', { ...ctx, orderSn, couriers: valid });

    // 找最低价
    const cheapest = valid.reduce((a, b) => (a.price.totalPrice || 999999) <= (b.price.totalPrice || 999999) ? a : b);

    let lines = ['全部快递报价', ''];
    valid.forEach((c, i) => {
      let line = (i+1) + '. ' + c.shipName + ' — ' + c.price.totalPriceStr + '元';
      if (c.price.needCount && c.price.nextStagePriceStr) line += ' | 再寄' + c.price.needCount + '单 ' + c.price.nextStagePriceStr + '元/单';
      if (c.shipCode === cheapest.shipCode) line += ' ← 最低价';
      lines.push(line);
    });
    lines.push('');
    lines.push('当前价格最低的为: ' + cheapest.shipName + ' (' + cheapest.price.totalPriceStr + '元)');
    lines.push('回复「确认」或「1」默认寄出 ' + cheapest.shipName + '，其他快递请回复对应序号。');
    lines.push('订单号: ' + orderSn);
    lines.push('回复「取消」退出。(10分钟超时)');
    await send(user, lines.join('\n'));
    return null;
  } catch (e) {
    console.error(`[${ts()}] 报价失败: ${e.message}`);
    db.clearSession(user);
    if (e.name === 'CookieExpiredError') return { type: 'text', content: '登录已过期。' };
    return { type: 'text', content: '失败: ' + e.message };
  }
}

async function afterAddressConfirmed(user, ctx) { return await showPricesOnly(user, ctx); }

async function confirmAndShip(user, ctx, chosen) {
  const sender = getSender(db.getSession(user));
  await send(user, '最终确认\n\n发件人: ' + sender.name + ' ' + sender.mobile + '\n发件地址: ' + sender.province + sender.city + sender.district + ' ' + sender.addressDetail + '\n\n收件人: ' + ctx.addr.consignee + '\n手机: ' + ctx.addr.phone + '\n地址: ' + ctx.addr.province + ctx.addr.city + ctx.addr.district + ' ' + ctx.addr.detail + '\n\n快递: ' + chosen.shipName + '\n费用: ' + (chosen.price?.totalPriceStr||'?') + '元\n\n回复"是"确认下单。回复「取消」退出。(10分钟超时)');
  db.setSession(user, 'confirm', { ...ctx, chosenCourier: chosen });
  return null;
}

async function doShip(user, ctx) {
  try {
    const chosen = ctx.chosenCourier;
    const sender = getSender(db.getSession(user));
    const selectedOrders = ctx.selectedOrders;

    // 多单寄件（从待寄件列表批量寄出）
    if (selectedOrders && selectedOrders.length > 0) {
      const result = await pdd.createShipmentBatch({
        sender,
        courierInfo: { shipCode: chosen.shipCode, shipName: chosen.shipName, branchId: chosen.branchId || 0, courierId: chosen.branchId || 0, deliveryModel: 2 },
        orders: selectedOrders.map(o => ({
          orderSn: o.orderSn,
          predictPrice: o.predictPrice || 0,
          predictWeight: o.goodsWeight || 1000,
        })),
      });
      let success = 0, fail = 0;
      (result.resultList || []).forEach(item => {
        if (item.success) { success++; } else { fail++; }
      });
      db.clearSession(user);
      const waybill = result.resultList?.[0]?.waybillCode || '';
      await send(user, '寄件完成\n\n快递: ' + chosen.shipName + '\n成功: ' + success + ' 单' + (fail ? '\n失败: ' + fail + ' 单' : '') + '\n运单号(首单): ' + waybill + '\n费用: ' + (chosen.price?.totalPriceStr || '') + '元/单\n\n回复 3 查看已寄出。');
      return null;
    }

    // 单单寄件（标准流程）
    const result = await pdd.createShipment({
      sender, orderSn: ctx.orderSn, goodsWeight: 1000, predictPrice: chosen.price?.totalPrice || 0,
      courierInfo: { shipCode: chosen.shipCode, shipName: chosen.shipName, branchId: chosen.branchId || 0, courierId: chosen.branchId || 0, deliveryModel: 2 },
    });
    const shipItem = result.resultList?.[0] || {};
    if (shipItem.success === false) throw new Error(shipItem.errorMessageToFrontend || '提交失败');
    const waybill = shipItem.waybillCode || '';
    db.createShipment({
      manual_sn: ctx.orderSn, delivery_sn: shipItem.deliveryReceiptSn || '', waybill_code: waybill,
      receiver_name: ctx.addr.consignee, receiver_mobile: ctx.addr.phone, receiver_address: ctx.addr.detail,
      receiver_province: ctx.addr.province, receiver_city: ctx.addr.city, receiver_district: ctx.addr.district,
      receiver_province_id: String(ctx.addr.provinceId), receiver_city_id: String(ctx.addr.cityId), receiver_district_id: String(ctx.addr.districtId),
      courier_name: chosen.shipName, courier_code: chosen.shipCode, ship_code: chosen.shipCode, branch_id: 0,
      price: chosen.price?.totalPrice || 0, price_str: chosen.price?.totalPriceStr || '', status: 'shipped', wechat_user: user,
    });
    db.clearSession(user);
    await send(user, '寄件下单成功\n\n快递: ' + chosen.shipName + '\n运单号: ' + waybill + '\n费用: ' + chosen.price.totalPriceStr + '元\n收件人: ' + (ctx.addr.consignee||'') + '\n地址: ' + ctx.addr.province + ctx.addr.city + ctx.addr.district + ' ' + ctx.addr.detail);
    return null;
  } catch (e) {
    console.error(`[${ts()}] 寄件失败: ${e.message}`);
    db.clearSession(user);
    if (e.name === 'CookieExpiredError') return { type: 'text', content: '登录已过期。' };
    return { type: 'text', content: '寄件失败: ' + e.message };
  }
}

module.exports = { handleMessage };
