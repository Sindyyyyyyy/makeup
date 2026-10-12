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

// ============ 过期预约自动结算 ============
// 时段结束时刻（本地 24 小时制）：上午 11 点后 / 下午 17 点后 / 晚上 21 点后
const SLOT_END_HOUR = { morning: 11, afternoon: 17, evening: 21 };
const SWEEP_LIMIT = 100;

// 云函数运行时区不保证是东八区，这里统一按 UTC+8 计算「今天」和当前小时
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    hour: d.getUTCHours(),
  };
}

// pending 且时段已过 → rejected；confirmed 且时段已过 → completed
async function autoExpireOverdue() {
  const now = beijingNow();
  let res;
  try {
    // 只按 status 单字段过滤（复合条件需要数据库索引），日期在内存里判定
    res = await db.collection('bookings')
      .where({ status: db.command.in(['pending', 'confirmed']) })
      .limit(SWEEP_LIMIT)
      .get();
  } catch (e) {
    console.warn('autoExpireOverdue 查询失败，跳过本次结算:', e.message);
    return { expired: 0 };
  }

  let expired = 0;
  for (const b of res.data) {
    const endHour = SLOT_END_HOUR[b.slot];
    if (endHour === undefined) continue;
    const overdue = b.date < now.date ||
      (b.date === now.date && now.hour >= endHour);
    if (!overdue) continue;

    const nextStatus = b.status === 'pending' ? 'rejected' : 'completed';
    let updated = 0;
    try {
      // 条件更新：状态被别人（管理员/顾客）改过就跳过，避免覆盖
      const upd = await db.collection('bookings').where({
        _id: b._id,
        status: b.status,
      }).update({ data: { status: nextStatus, updateTime: db.serverDate() } });
      updated = upd.stats.updated;
    } catch (e) {
      console.warn('autoExpireOverdue 更新失败', b._id, e.message);
      continue;
    }
    if (updated === 0) continue;

    // 与 adminUpdateBooking 保持一致的时段副作用：
    // 自动拒绝要释放时段占用，自动完成只打 done 标记
    try {
      const slotRes = await db.collection('timeSlots').where({ date: b.date }).limit(1).get();
      const slotDoc = slotRes.data && slotRes.data[0];
      if (slotDoc) {
        const data = nextStatus === 'rejected'
          ? { [`${b.slot}.booked`]: false, [`${b.slot}.done`]: false }
          : { [`${b.slot}.done`]: true };
        await db.collection('timeSlots').doc(slotDoc._id).update({ data });
      }
    } catch (e) {
      console.warn('autoExpireOverdue 释放时段失败', b._id, e.message);
    }
    expired++;
  }
  if (expired) console.log(`autoExpireOverdue: 本次自动结算 ${expired} 条`);
  return { expired };
}
// ================================================================

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  try {
    await autoExpireOverdue();
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