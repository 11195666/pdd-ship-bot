const axios = require('axios');
const crypto = require('crypto');
const xml2js = require('xml2js');
const config = require('./config');

const WECOM = config.wecom;
const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

// ── Access Token 缓存 ──
let _accessToken = null;
let _tokenExpireAt = 0;

const getAccessToken = async () => {
  if (_accessToken && Date.now() < _tokenExpireAt) return _accessToken;
  const url = `${API_BASE}/gettoken?corpid=${WECOM.corpId}&corpsecret=${WECOM.secret}`;
  const resp = await axios.get(url);
  if (resp.data.errcode !== 0) throw new Error(`获取 access_token 失败: ${resp.data.errmsg}`);
  _accessToken = resp.data.access_token;
  _tokenExpireAt = Date.now() + (resp.data.expires_in - 300) * 1000;
  return _accessToken;
};

// ── 消息加解密 ──
class WXBizMsgCrypt {
  constructor() {
    this.token = WECOM.token;
    this.encodingAESKey = WECOM.encodingAESKey + '=';
    this.corpId = WECOM.corpId;
    this.key = Buffer.from(this.encodingAESKey, 'base64');
  }

  verifyURL(msgSignature, timestamp, nonce, echostr) {
    const signature = this._sha1(timestamp, nonce, echostr);
    if (signature !== msgSignature) throw new Error('签名验证失败');
    return this._decrypt(echostr);
  }

  decryptMsg(msgSignature, timestamp, nonce, encryptedBody) {
    const parser = new xml2js.Parser({ explicitArray: false });
    return new Promise((resolve, reject) => {
      parser.parseString(encryptedBody, (err, result) => {
        if (err) return reject(err);
        const ciphertext = result.xml.Encrypt;
        const signature = this._sha1(timestamp, nonce, ciphertext);
        if (signature !== msgSignature) return reject(new Error('消息签名验证失败'));
        const decrypted = this._decrypt(ciphertext);
        parser.parseString(decrypted, (e2, r2) => {
          if (e2) return reject(e2);
          resolve(r2.xml);
        });
      });
    });
  }

  _sha1(timestamp, nonce, encrypt) {
    const arr = [this.token, timestamp, nonce, encrypt].sort();
    return crypto.createHash('sha1').update(arr.join('')).digest('hex');
  }

  _decrypt(encrypted) {
    const iv = this.key.subarray(0, 16);
    const ciphertext = Buffer.from(encrypted, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.key, iv);
    decipher.setAutoPadding(false);
    let decoded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const padLen = decoded[decoded.length - 1];
    if (padLen > 0 && padLen <= 32) decoded = decoded.subarray(0, decoded.length - padLen);

    const msgLen = decoded.readUInt32BE(16);
    const msg = decoded.subarray(20, 20 + msgLen).toString('utf8');
    const receivedCorpId = decoded.subarray(20 + msgLen).toString('utf8');
    if (receivedCorpId !== this.corpId) throw new Error('CorpId 不匹配: ' + receivedCorpId);
    return msg;
  }
}

// ── 发送消息 ──
const sendMessage = async (user, content, type = 'text') => {
  const token = await getAccessToken();
  const body = { touser: user, msgtype: type, agentid: WECOM.agentId };
  switch (type) {
    case 'text': body.text = { content }; break;
    case 'markdown': body.markdown = { content }; break;
  }
  const url = `${API_BASE}/message/send?access_token=${token}`;
  const resp = await axios.post(url, body);
  if (resp.data.errcode !== 0) {
    console.error(`[WeChat] 发送消息失败: ${resp.data.errmsg}`);
  }
  return resp.data;
};

module.exports = { WXBizMsgCrypt, getAccessToken, sendMessage };
