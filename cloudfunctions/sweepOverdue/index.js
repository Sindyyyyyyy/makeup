const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// ============ 过期预约自动结算 ============
// 由 config.json 里的定时触发器每小时调用一次。
// 这段逻辑原先被复制粘贴进 listWeekSchedule / listMyBookings / adminGetBookings
// 三个「读取类」函数，导致每次读列表都要全表扫一遍 bookings（最坏 301 次 DB 往返，
// 而 adminGetBookings 分页，翻一页就重扫一次）。改为定时触发后，热路径上的
// 列表查询回到 1-2 次 DB 读。
//
// 时段结束时刻（本地 24 小时制）：上午 11 点后 / 下午 17 点后 / 晚上 21 点后
// 与 adminUpdateBooking / createBooking 保持一致，改一处要改几处
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

  // 先在内存里筛出真正过期的，省掉对不过期条目的写尝试
  const overdueList = res.data.filter(b => {
    const endHour = SLOT_END_HOUR[b.slot];
    if (endHour === undefined) return false;
    return b.date < now.date || (b.date === now.date && now.hour >= endHour);
  });
  if (overdueList.length === 0) return { expired: 0 };

  // 与 adminUpdateBooking 保持一致的时段副作用：
  // 自动拒绝要释放时段占用，自动完成只打 done 标记。
  // timeSlots 按 date 去重后再查——同一批过期预约常常落在同一天（一天 3 个时段），
  // 原来每条预约各查一次，这里每日期只查一次。
  const dates = Array.from(new Set(overdueList.map(b => b.date)));
  const slotDocs = new Map();
  try {
    const slotRes = await db.collection('timeSlots').where({ date: db.command.in(dates) }).get();
    (slotRes.data || []).forEach(d => slotDocs.set(d.date, d));
  } catch (e) {
    // 时段查不到就只改预约状态，不释放占用（人工介入即可），不整批失败
    console.warn('autoExpireOverdue 查询时段失败，仅结算预约状态:', e.message);
  }

  // 各条预约之间互不影响，并发执行（原实现是完全串行的）
  const results = await Promise.all(overdueList.map(async (b) => {
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
      return 0;
    }
    if (updated === 0) return 0;

    const slotDoc = slotDocs.get(b.date);
    if (slotDoc) {
      try {
        const data = nextStatus === 'rejected'
          ? { [`${b.slot}.booked`]: false, [`${b.slot}.done`]: false }
          : { [`${b.slot}.done`]: true };
        await db.collection('timeSlots').doc(slotDoc._id).update({ data });
      } catch (e) {
        console.warn('autoExpireOverdue 释放时段失败', b._id, e.message);
      }
    }
    return 1;
  }));

  const expired = results.reduce((a, n) => a + n, 0);
  if (expired) console.log(`autoExpireOverdue: 本次自动结算 ${expired} 条`);
  return { expired };
}

exports.main = async () => {
  return await autoExpireOverdue();
};