const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// ============ 管理令牌校验（与 adminLogin 签发逻辑保持一致）============
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'makeup-miniprogram-token-secret-v1';

function verifyAdmin(event, context) {
  const token = event && event.token;
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  const given = Buffer.from(sig, 'utf8');
  const expectBuf = Buffer.from(expect, 'utf8');
  if (given.length !== expectBuf.length || !crypto.timingSafeEqual(given, expectBuf)) return false;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (e) {
    return false;
  }
  return !!data && typeof data.exp === 'number' && Date.now() <= data.exp;
}
// ================================================================

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  try {
    const { startDate, endDate } = event;
    const where = {};
    if (startDate && endDate) {
      where.date = db.command.gte(startDate).and(db.command.lte(endDate));
    } else if (startDate) {
      where.date = db.command.gte(startDate);
    } else if (endDate) {
      where.date = db.command.lte(endDate);
    }

    const res = await db.collection('timeSlots')
      .where(where)
      .orderBy('date', 'asc')
      .limit(100) // 日期区间理论上无界，兜一个上限防止响应体积失控
      .get();

    return { success: true, slots: res.data };
  } catch (err) {
    console.error('adminListSlots error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};