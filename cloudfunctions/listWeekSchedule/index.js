const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const MAX_DATES = 31;

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

exports.main = async (event, context) => {
  const { dates } = event;
  let wxCtx = {};
  try {
    wxCtx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
  } catch (e) {}
  const openid = (wxCtx && wxCtx.OPENID) || (context && context.OPENID) || null;

  if (!Array.isArray(dates) || dates.length === 0) {
    return { success: false, message: '缺少日期参数' };
  }
  if (dates.length > MAX_DATES) {
    return { success: false, message: '查询日期过多' };
  }
  const clean = dates.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (clean.length === 0) {
    return { success: false, message: '日期格式不正确' };
  }

  try {
    // 先结算过期预约，否则时段占用/我的预约会停留在旧状态
    await autoExpireOverdue();

    // 时段开放情况属于公共数据
    const tsRes = await db.collection('timeSlots')
      .where({ date: db.command.in(clean) })
      .get();

    // 我的预约只能查自己的，服务端强制注入 _openid
    let myBookings = [];
    if (openid) {
      const bkRes = await db.collection('bookings').where({
        _openid: openid,
        date: db.command.in(clean),
        status: db.command.in(['pending', 'confirmed']),
      }).get();
      myBookings = bkRes.data.map(b => ({
        _id: b._id,
        date: b.date,
        slot: b.slot,
        status: b.status,
      }));
    }

    return { success: true, timeSlots: tsRes.data, myBookings };
  } catch (err) {
    console.error('listWeekSchedule error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};