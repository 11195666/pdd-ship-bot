/**
 * LLM 自然语言寄件渠道
 *
 * 通过 OpenAI 兼容接口，将自然语言转换为结构化指令。
 * 支持所有兼容 OpenAI API 的服务商（DeepSeek / 通义千问 / ollama 等）。
 * 配置见 .env.example。
 *
 * 使用示例：
 *   "帮我把第一个待寄件寄了" → LLM → 调 listPreparingOrders → createShipment
 */

const { Channel, Message, Reply } = require('../channel');

// ── 系统提示词：告知 LLM 可用功能和参数规则 ──
// 系统提示词：优先从 .env 读取 LLM_SYSTEM_PROMPT，否则用内置默认值
const DEFAULT_PROMPT = `你是「拼多多寄件助手」，你的任务是帮助用户完成寄件相关操作。

你有以下工具。根据用户意图主动调用，不用反复确认：

1. list_preparing_orders() — 查待寄件
2. create_order_and_query({ addressText }) — 地址建单+比价
3. predict_all_prices({ orderSn }) — 对比价格
4. ship_order({ orderSn, shipCode }) — 寄出订单
5. batch_ship({ shipCode }) — 批量寄出所有
6. delete_order({ orderSn }) — 删除单个待寄件
7. delete_all_orders() — 删除全部待寄件
8. list_shipped_orders() — 查已寄出
9. cancel_shipment({ deliverySn }) — 取消寄件
10. help() — 帮助

工作方式：
- 用户说什么，你就做什么。直接调用工具执行，不要让用户确认。
- 如果用户说不寄了/取消了/算了，就停止操作并告知结果。
- 一句话多个意图也要处理。比如"看看有几个待寄件，把第一个删掉" → 先查列表，再删第一个。
- 拿不准的时候，猜一个最可能的去做，做完了告诉用户结果。
- 做错了用户会告诉你的，到时候再改。

shipCode 对照：YTO(圆通) YUNDA(韵达) JTSD(极兔) STO(申通) ZTO(中通) SF(顺丰)

回复规范：
- 创建订单并比价后：列出各快递价格、标出最低价，问用户要不要寄出
- 用户说"寄"就调 ship_order 执行，成功后回复【运单号】xxx
- 查询类操作（查列表、查价格）直接返回结果
- 简洁自然`;
const SYSTEM_PROMPT = (() => {
  const fromEnv = process.env.LLM_SYSTEM_PROMPT;
  if (fromEnv) return fromEnv;
  const fromFile = process.env.LLM_SYSTEM_PROMPT_FILE;
  if (fromFile) {
    try { return require('fs').readFileSync(fromFile, 'utf8'); } catch (_) {}
  }
  return DEFAULT_PROMPT;
})();

// ── 可用函数映射（由外部注入，避免直接依赖 pdd.js） ──
const FUNCTION_MAP = {};

function registerFunctions(fns) {
  Object.assign(FUNCTION_MAP, fns);
}

// ── 函数定义（OpenAI Function Calling 格式） ──
const FUNCTIONS = [
  {
    name: 'list_preparing_orders',
    description: '获取待寄件手工订单列表',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_order_and_query',
    description: '从收货地址创建订单并查询各快递价格。用户给出地址时调用此函数，无需先手工创建订单。',
    parameters: {
      type: 'object',
      properties: {
        addressText: { type: 'string', description: '收件人地址全文，如"张三 13800138000 浙江省杭州市西湖区文三路478号"' },
      },
      required: ['addressText'],
    },
  },
  {
    name: 'predict_all_prices',
    description: '对比所有快递价格，找出最低价',
    parameters: {
      type: 'object',
      properties: { orderSn: { type: 'string', description: '订单号' } },
      required: ['orderSn'],
    },
  },
  {
    name: 'ship_order',
    description: '寄出指定订单',
    parameters: {
      type: 'object',
      properties: {
        orderSn: { type: 'string', description: '订单号' },
        shipCode: { type: 'string', enum: ['YTO', 'YUNDA', 'JTSD', 'STO', 'ZTO', 'SF', 'YZDSBK'] },
        predictPrice: { type: 'number', description: '预估价格（分），从 predict_price 获取' },
      },
      required: ['orderSn', 'shipCode'],
    },
  },
  {
    name: 'delete_order',
    description: '删除单个待寄件订单。',
    parameters: {
      type: 'object',
      properties: { orderSn: { type: 'string', description: '要删除的订单号' } },
      required: ['orderSn'],
    },
  },
  {
    name: 'delete_all_orders',
    description: '批量删除所有待寄件订单。用户说"全部删除/删完/清空"时用这个。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_shipped_orders',
    description: '获取最近已寄件记录',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_shipment',
    description: '取消寄件',
    parameters: {
      type: 'object',
      properties: { deliverySn: { type: 'string', description: '寄件单号' } },
      required: ['deliverySn'],
    },
  },
  {
    name: 'batch_ship',
    description: '批量寄出所有待寄件订单',
    parameters: {
      type: 'object',
      properties: { shipCode: { type: 'string', enum: ['YTO', 'YUNDA', 'JTSD', 'STO', 'ZTO', 'SF', 'YZDSBK'] } },
      required: ['shipCode'],
    },
  },
  {
    name: 'help',
    description: '显示帮助信息和功能列表',
    parameters: { type: 'object', properties: {} },
  },
];

// ── LLM 调用 ──
async function callLLM(messages, options = {}) {
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  if (!apiKey) throw new Error('未配置 LLM_API_KEY');

  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    temperature: 0.1,
  };

  // 模型支持工具调用时传入 tools
  if (options.enableTools !== false && FUNCTIONS.length > 0) {
    body.tools = FUNCTIONS.map(f => ({ type: 'function', function: f }));
    body.tool_choice = 'auto';
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000), // 30 秒超时
  });

  if (!resp.ok) {
    const text = await resp.text();
    // 如果不支持工具调用，降级重试
    if (options.enableTools !== false && (text.includes('tool') || text.includes('function') || text.includes('not supported'))) {
      console.log('[llm] 模型不支持工具调用，降级为纯文本模式');
      return callLLM(messages, { ...options, enableTools: false });
    }
    throw new Error(`LLM API ${resp.status}: ${text.substring(0, 200)}`);
  }
  return await resp.json();
}

// ── 执行工具调用 ──
async function executeToolCall(toolCall) {
  const { name, arguments: args } = toolCall.function;
  const parsed = JSON.parse(args);
  const fn = FUNCTION_MAP[name];
  if (!fn) return { error: `未知函数: ${name}` };

  try {
    const result = await fn(parsed);
    return { result };
  } catch (e) {
    return { error: e.message };
  }
}

// ── 处理用户消息 ──
async function processMessage(text, history = []) {
  const messages = [...history, { role: 'user', content: text }];

  const data = await callLLM(messages);
  const choice = data.choices?.[0];
  if (!choice) throw new Error('LLM 无响应');

  // 无工具调用 → 直接返回文本回复
  if (!choice.message.tool_calls?.length) {
    return {
      reply: choice.message.content || '抱歉，我没有理解您的意思。',
      history: [...messages, { role: 'assistant', content: choice.message.content || '' }],
    };
  }

  // 执行工具调用
  for (const toolCall of choice.message.tool_calls) {
    const { result, error } = await executeToolCall(toolCall);
    const content = error ? JSON.stringify({ error }) : JSON.stringify(result);
    messages.push(choice.message);
    messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
  }

  // 调 LLM 生成最终回复
  const finalData = await callLLM(messages);
  const finalContent = finalData.choices?.[0]?.message?.content || '处理完成。';
  return {
    reply: finalContent,
    history: [...messages, { role: 'assistant', content: finalContent }],
  };
}

// ── 格式化结果为可读文本（供 channel send 使用） ──
function formatResult(name, data) {
  if (!data) return '操作完成。';
  switch (name) {
    case 'list_preparing_orders': {
      if (!data.length) return '暂无待寄件订单。回复"寄件"开始新建。';
      return data.map((o, i) =>
        `${i + 1}. ${o.receiveName || '?'} ${o.receiverProvince}${o.receiverCity}${o.receiverDistrict} [${o.orderSn}]`
      ).join('\n') + '\n\n回复序号可选择寄出。';
    }
    case 'list_shipped_orders': {
      if (!data.length) return '暂无已寄件记录。';
      return data.map(o =>
        `${o.shipName} ${o.waybillCode || '?'} ${o.totalPriceStr || ''}元 → ${o.receiverName}`
      ).join('\n');
    }
    default:
      return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  }
}

// ═══════════════════════════════════════════════════════════════
//  LLM 渠道
// ═══════════════════════════════════════════════════════════════

class LlmChannel extends Channel {
  constructor(config) {
    super('llm', config);
    this.app = null;
  }

  async start() {
    if (!this.enabled) return;
    if (!process.env.LLM_API_KEY) {
      console.log('[llm] 未配置 LLM_API_KEY，不启动');
      return;
    }
    if (!this.app) throw new Error('[llm] 需要传入 Express app');

    // 注册 API 路由（供其他渠道转发或直接测试）
    this.app.post('/api/llm', async (req, res) => {
      const { text, history } = req.body || {};
      if (!text) return res.status(400).json({ error: '缺少 text' });
      try {
        const result = await processMessage(text, history);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    console.log(`[llm] 渠道已启动 (model: ${process.env.LLM_MODEL || 'gpt-4o-mini'})`);
  }

  /** 处理一条消息，返回 Reply */
  async handleMessage(text) {
    const { reply, history } = await processMessage(text);
    return { reply: new Reply(reply), history };
  }

  async send(reply, originalMsg) {
    // LLM 渠道的回复通过调用方（WeCom 等）的 send 发出
    throw new Error('[llm] 请通过上游渠道发送回复');
  }
}

module.exports = { LlmChannel, processMessage, registerFunctions, formatResult, FUNCTIONS };
