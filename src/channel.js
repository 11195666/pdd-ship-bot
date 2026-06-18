/**
 * 多渠道消息抽象层
 *
 * 统一消息/回复格式，定义渠道接口。
 * 新增渠道只需继承 Channel 类，实现 start() 和 send()。
 */

class Message {
  /** @param {{ from: string, content: string, channel: string, chatId?: string, raw?: any }} opts */
  constructor(opts) {
    this.from = opts.from;         // 发送者标识（用户ID、群ID等）
    this.content = opts.content;   // 文本内容
    this.channel = opts.channel;   // 渠道名称，如 'wecom'
    this.chatId = opts.chatId;     // 群聊/会话ID
    this.raw = opts.raw;           // 原始消息（渠道特定的完整消息对象）
  }
}

class Reply {
  /** @param {{ content: string, type?: string }} opts */
  constructor(content, type = 'text') {
    if (typeof content === 'object') {
      this.content = content.content;
      this.type = content.type || 'text';
    } else {
      this.content = content;
      this.type = type;
    }
  }
}

/**
 * 渠道基类
 */
class Channel {
  constructor(name, config = {}) {
    this.name = name;
    this.enabled = config.enable !== false;
  }

  /** 启动渠道监听，收到消息时调用 onMessage(msg: Message) */
  async start(onMessage) {
    throw new Error(`[${this.name}] 未实现 start()`);
  }

  /** 发送回复。reply: Reply, originalMsg: Message（用于定位发送目标） */
  async send(reply, originalMsg) {
    throw new Error(`[${this.name}] 未实现 send()`);
  }

  /** 停止渠道 */
  async stop() {}
}

module.exports = { Message, Reply, Channel };
