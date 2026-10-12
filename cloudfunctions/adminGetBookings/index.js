const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const PAGE_SIZE = 100;
const MAX_PAGE = 20;

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

// 过期预约的自动结算已挪到定时触发的 sweepOverdue 云函数，
// 这里是纯读取路径，翻页/刷新都不会再产生写操作。

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  try {
    const { status, date } = event;
    const page = Math.max(0, Math.min(MAX_PAGE, parseInt(event.page, 10) || 0));
    const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize, 10) || PAGE_SIZE));

    const where = {};
    if (status) where.status = status;
    if (date) where.date = date;

    const res = await db.collection('bookings')
      .where(where)
      .orderBy('createTime', 'desc')
      .skip(page * pageSize)
      .limit(pageSize)
      .get();

    return {
      success: true,
      bookings: res.data,
      page,
      hasMore: res.data.length === pageSize,
    };
  } catch (err) {
    console.error('adminGetBookings error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};