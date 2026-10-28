const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// ============ 过期预约自动结算 ============
// 由 config.json 里的定时触发器每小时调用一次。
// 这段逻辑原先被复制粘贴进 listWeekSchedule / listMyBookings / adminGetBookings
// 三个「读取类」函数，导致每次读列表都要全表扫一遍 bookings（最坏 301 次 DB 往返，
// 而 adminGetBookings 分页，翻一页就重扫一次）。改为定时触发后，热路径上的
// 列表查询回到 1-2 次 DB 读。
const SWEEP_LIMIT = 100;
// `in` 的元素个数有上限，超过就分批查（库里没有复合索引用，只有单字段）
const IN_CHUNK = 50;

// ============ 时段配置 ============
// 结束时刻是数据不是代码：权威值在 timeSlots 集合的 _id='slot_times' 文档里
//   { morning:{start,end}, afternoon:{...}, evening:{...},
//     overrides: { 'YYYY-MM-DD': { morning:{start,end} } } }
// 某一天某时段的结束时刻 = overrides[date][slot].end ?? 全局的 slot.end。
// 与 miniprogram/utils/slots.js 是同一套规则（两个目录不共享文件系统，只能各抄一份）。
const CONFIG_DOC_ID = 'slot_times';
const DEFAULT_TIMES = {
  morning: { start: '09:30', end: '11:30' },
  afternoon: { start: '14:00', end: '17:00' },
  evening: { start: '18:00', end: '21:00' },
};

// 读配置文档。文档还不存在（第一次用）时退回默认值。
async function readSlotTimes() {
  try {
    const res = await db.collection('timeSlots').doc(CONFIG_DOC_ID).get();
    const d = res && res.data;
    if (!d) return { ...DEFAULT_TIMES, overrides: {} };
    const out = { overrides: (d.overrides && typeof d.overrides === 'object') ? d.overrides : {} };
    ['morning', 'afternoon', 'evening'].forEach(k => {
      const t = d[k];
      out[k] = (t && t.start && t.end) ? { start: t.start, end: t.end } : { ...DEFAULT_TIMES[k] };
    });
    return out;
  } catch (e) {
    return { ...DEFAULT_TIMES, overrides: {} };
  }
}

// 某一天某个时段的结束时刻（单日覆盖优先）
function effectiveEnd(times, date, slot) {
  const day = times && times.overrides && times.overrides[date];
  const ov = day && day[slot];
  if (ov && ov.end) return ov.end;
  const g = times && times[slot];
  return (g && g.end) || '';
}

// 'HH:MM' → 从 00:00 起的分钟数；不是合法时刻则返回 null
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// 云函数运行时区不保证是东八区，这里统一按 UTC+8 计算「今天」和当前时刻
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

// 按日期批量查时段文档（`in` 分批，避免元素个数超限）
async function querySlotsByDate(dates) {
  const map = new Map();
  const uniq = Array.from(new Set(dates.filter(Boolean)));
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const batch = uniq.slice(i, i + IN_CHUNK);
    try {
      const res = await db.collection('timeSlots').where({ date: db.command.in(batch) }).get();
      (res.data || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
    } catch (e) {
      console.warn('autoExpireOverdue 查询时段失败:', e.message);
    }
  }
  return map;
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

  // 结束时刻来自配置（单日覆盖优先），不是写死的整数小时
  const times = await readSlotTimes();

  // 先在内存里筛出真正过期的，省掉对不过期条目的写尝试
  const overdueList = (res.data || []).filter((b) => {
    if (!b || !b.date) return false;
    if (b.date < now.date) return true;      // 过去的日子，一律结算
    if (b.date > now.date) return false;     // 还没到，不动
    const end = effectiveEnd(times, b.date, b.slot);
    const em = toMinutes(end);
    if (em === null) return false;           // 结束时刻不认得，宁可不结算也不误杀
    return now.hour * 60 + now.minute >= em;
  });
  if (overdueList.length === 0) return { expired: 0 };

  // 与 adminUpdateBooking 保持一致的时段副作用：
  // 自动拒绝要释放时段占用，自动完成只打 done 标记。
  // timeSlots 按 date 去重后再查——同一批过期预约常常落在同一天（一天 3 个时段），
  // 原来每条预约各查一次，这里每日期只查一次。
  const dates = Array.from(new Set(overdueList.map(b => b.date)));
  const slotDocs = await querySlotsByDate(dates);

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
