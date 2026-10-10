const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 诊断用：查看云函数到底能拿到什么，用于排查 openid 取不到的问题
exports.main = async (event, context) => {
  let wxCtx = {};
  let getWxCtxError = null;
  try {
    wxCtx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
  } catch (e) {
    getWxCtxError = e.message;
  }

  const info = {
    openidFromApi: (wxCtx && wxCtx.OPENID) || null,
    openidFromContext: (context && context.OPENID) || null,
    apiAvailable: typeof cloud.getWXContext === 'function',
    getWxCtxError,
    apiContext: wxCtx,
    contextKeys: Object.keys(context || {}),
    clientIp: (wxCtx && wxCtx.CLIENTIP) || null,
  };
  console.log('whoami:', JSON.stringify(info));
  return { success: true, info };
};