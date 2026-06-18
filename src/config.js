const config = {
  wecom: {
    corpId:         process.env.WECOM_CORP_ID         || '',
    agentId:        process.env.WECOM_AGENT_ID        || '1000004',
    secret:         process.env.WECOM_SECRET          || '',
    token:          process.env.WECOM_TOKEN           || '',
    encodingAESKey: process.env.WECOM_ENCODING_AES    || '',
  },

  pdd: {
    username:  process.env.PDD_USERNAME || '',
    password:  process.env.PDD_PASSWORD || '',
    loginUrl:  process.env.PDD_LOGIN_URL || 'https://mms.pinduoduo.com',

    sender: {
      addressId:     parseInt(process.env.PDD_SENDER_ADDRESS_ID) || 0,
      name:          process.env.PDD_SENDER_NAME        || '',
      mobile:        process.env.PDD_SENDER_MOBILE      || '',
      province:      process.env.PDD_SENDER_PROVINCE    || '',
      city:          process.env.PDD_SENDER_CITY        || '',
      district:      process.env.PDD_SENDER_DISTRICT    || '',
      addressDetail: process.env.PDD_SENDER_ADDRESS     || '',
      provinceId:    parseInt(process.env.PDD_SENDER_PROVINCE_ID) || 0,
      cityId:        parseInt(process.env.PDD_SENDER_CITY_ID)     || 0,
      districtId:    parseInt(process.env.PDD_SENDER_DISTRICT_ID) || 0,
    },
  },

  get senders() {
    if (process.env.PDD_SENDERS) {
      try { return JSON.parse(process.env.PDD_SENDERS); } catch (_) {}
    }
    const list = [];
    for (let i = 1; i <= 5; i++) {
      const name = process.env[`PDD_SENDER_${i}_NAME`];
      if (!name) break;
      list.push({
        addressId:     parseInt(process.env[`PDD_SENDER_${i}_ADDRESS_ID`]) || 0,
        name:          name || '',
        mobile:        process.env[`PDD_SENDER_${i}_MOBILE`]      || '',
        province:      process.env[`PDD_SENDER_${i}_PROVINCE`]    || '',
        city:          process.env[`PDD_SENDER_${i}_CITY`]        || '',
        district:      process.env[`PDD_SENDER_${i}_DISTRICT`]    || '',
        addressDetail: process.env[`PDD_SENDER_${i}_ADDRESS`]     || '',
        provinceId:    parseInt(process.env[`PDD_SENDER_${i}_PROVINCE_ID`]) || 0,
        cityId:        parseInt(process.env[`PDD_SENDER_${i}_CITY_ID`])     || 0,
        districtId:    parseInt(process.env[`PDD_SENDER_${i}_DISTRICT_ID`]) || 0,
      });
    }
    return list;
  },

  port:              parseInt(process.env.PORT) || 3456,
  pddLoginUrl:       process.env.PDD_LOGIN_URL || 'https://mms.pinduoduo.com',
  pddBaseUrl:        'https://mms.pinduoduo.com',
  smsSocketIOUrl:    process.env.SMS_SOCKETIO_URL || '',
  smsWebhookSecret:  process.env.SMS_WEBHOOK_SECRET || '',
  cookieRefreshHours: parseInt(process.env.COOKIE_REFRESH_HOURS) || 20,
  defaultGoodsWeight: 1000,
};

module.exports = config;
