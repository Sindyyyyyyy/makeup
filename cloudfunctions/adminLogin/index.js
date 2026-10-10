const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 管理密码与令牌密钥仅存在于服务端（云函数代码不会打进小程序包）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'makeup2026';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'makeup-miniprogram-token-secret-v1';
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

function sign(payload) {
  return require('crypto').createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
}

exports.main = async (event) => {
  const { password } = event || {};

  if (password !== ADMIN_PASSWORD) {
    return { success: false, message: '权限验证失败' };
  }

  try {
    // 未登录的云函数调用拿不到 OPENID，登录阶段不绑定 openid
    const exp = Date.now() + TOKEN_TTL;
    const payload = Buffer.from(JSON.stringify({ exp })).toString('base64');
    const token = `${payload}.${sign(payload)}`;
    return { success: true, token, expiresAt: exp };
  } catch (err) {
    console.error('adminLogin error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};