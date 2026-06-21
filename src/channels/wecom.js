/**
 * 企业微信渠道适配器
 *
 * 接收企业微信回调 → 转为统一 Message → 调用业务逻辑
 * 业务逻辑返回 Reply → 通过企业微信 API 发送
 */

const { Channel, Message, Reply } = require('../channel');
const wechat = require('../wechat');

class WeComChannel extends Channel {
  constructor(config) {
    super('wecom', config);
    this.crypt = new wechat.WXBizMsgCrypt();
    this.app = null;
    this.processedIds = new Set(); // 消息去重
  }

  /** 注册 Express 路由。app: Express 实例, onMessage: (msg) => Promise<Reply|null> */
  async start(onMessage) {
    if (!this.enabled) return;
    if (!this.app) throw new Error('[wecom] 需要传入 Express app');

    // 注册回调路由
    this.app.get('/wechat/callback', (req, res) => {
      const { msg_signature, timestamp, nonce, echostr } = req.query;
      try {
        const result = this.crypt.verifyURL(msg_signature, timestamp, nonce, echostr);
        res.send(result);
      } catch (e) {
        console.error(`[wecom] URL验证失败: ${e.message}`);
        res.status(400).send('verify failed');
      }
    });

    this.app.post('/wechat/callback', async (req, res) => {
      const { msg_signature, timestamp, nonce } = req.query;
      try {
        const xmlMsg = await this.crypt.decryptMsg(msg_signature, timestamp, nonce, req.body);
        if (xmlMsg.MsgType !== 'text' || !xmlMsg.Content) { res.send('success'); return; }

        // 消息去重：企业微信超时会重试，同一 MsgId 只处理一次
        if (xmlMsg.MsgId) {
          if (this.processedIds.has(xmlMsg.MsgId)) { res.send('success'); return; }
          this.processedIds.add(xmlMsg.MsgId);
          if (this.processedIds.size > 1000) this.processedIds.clear();
        }

        console.log(`[wecom] ${xmlMsg.FromUserName}: ${xmlMsg.Content.substring(0, 40)}`);

        const msg = new Message({
          from: xmlMsg.FromUserName,
          content: xmlMsg.Content.trim(),
          channel: 'wecom',
          chatId: xmlMsg.FromUserName, // 企业微信用 FromUserName 作为会话标识
          raw: xmlMsg,
        });

        // 判断是否使用 LLM 处理
        const text = xmlMsg.Content.trim();
        const llmEnabled = process.env.LLM_ENABLE === 'true' && process.env.LLM_API_KEY;
        if (llmEnabled) {
          // LLM 模式：所有消息走大模型，完全屏蔽菜单
          console.log(`[wecom] LLM: ${text.substring(0, 40)}`);
          try {
            const { processMessage } = require('../channels/llm');
            const result = await processMessage(text);
            if (result?.reply) {
              // 寄件成功时，提取【运单号】后面的号码单独发一条，方便复制
              const waybillMatch = result.reply.match(/【运单号】(\S+)/);
              if (waybillMatch) {
                const mainMsg = result.reply;
                const waybillOnly = waybillMatch[0];
                await wechat.sendMessage(msg.from, mainMsg);
                await wechat.sendMessage(msg.from, waybillOnly);
              } else {
                await wechat.sendMessage(msg.from, result.reply);
              }
            }
          } catch (e) {
            console.error(`[wecom] LLM 错误: ${e.message}`);
            await wechat.sendMessage(msg.from, `出错了: ${e.message}\n\n确认 LLM_API_KEY 和网络正常后重试。`);
          }
        } else {
          // 原有 router 处理菜单命令
          const send = async (to, content) => { await wechat.sendMessage(to, content); };
          const { handleMessage } = require('../router');
          const reply = await handleMessage(msg, send);
          if (reply?.content) {
            await wechat.sendMessage(msg.from, reply.content, reply.type || 'text');
          }
        }
      } catch (e) {
        console.error(`[wecom] 处理失败: ${e.message}`);
      }
      res.send('success');
    });

    // 注册短信接收路由
    const sms = require('../sms');
    sms.registerRoutes(this.app);

    console.log('[wecom] 渠道已启动');
  }

  async send(reply, originalMsg) {
    if (!reply?.content) return;
    await wechat.sendMessage(originalMsg.from, reply.content, reply.type || 'text');
  }
}

module.exports = { WeComChannel };
