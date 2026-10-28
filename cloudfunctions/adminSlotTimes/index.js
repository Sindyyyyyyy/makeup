// cloudfunctions/adminSlotTimes - 化妆师设置时段的起止时间
//
// 时段的时间是数据，不是代码：权威值存在 timeSlots 集合里 _id='slot_times' 的那篇
// 配置文档中（本函数不新建集合，省掉「去控制台手动建集合」这一步；该文档没有 date
// 字段，所以按日期查时段表的所有查询都不会命中它）。
//
//   {
//     morning:   { start:'09:30', end:'11:30' },
//     afternoon: { start:'14:00', end:'17:00' },
//     evening:   { start:'18:00', end:'21:00' },
//     overrides: { '2026-10-28': { morning: { start:'10:00', end:'12:00' } } },
//     updateTime: <serverDate>
//   }
//
// 有效时间 = overrides[date][slot] ?? 全局的 slot（单日覆盖优先）。
// 这段规则在 miniprogram/utils/slots.js 里也有一份，两边必须一致。
//
// 改时间时同步更新还没完成的预约（bookings.slotName）：时间是化妆师的作息，
// 顾客是照着时间来的，改了不跟着改顾客会白跑一趟。
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

// ============ 时段配置 ============
const CONFIG_DOC_ID = 'slot_times';
const SLOT_KEYS = ['morning', 'afternoon', 'evening'];
const SLOT_LABELS = { morning: '上午', afternoon: '下午', evening: '晚上' };
// 兜底默认值：只在配置文档还不存在时用得到
const DEFAULT_TIMES = {
  morning: { start: '09:30', end: '11:30' },
  afternoon: { start: '14:00', end: '17:00' },
  evening: { start: '18:00', end: '21:00' },
};
// 单个时段的最短时长（分钟）。低于这个数就没法做一单化妆。
const MIN_DURATION = 60;

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function normHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return '';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

// 校验一段起止时间。返回 {start,end} 或 {error}
function parseRange(raw, label) {
  if (!raw || typeof raw !== 'object') return { error: `${label}的时间无效` };
  const start = normHM(raw.start);
  const end = normHM(raw.end);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return { error: `${label}的时间格式不正确（应为 HH:MM）` };
  if (s >= e) return { error: `${label}的开始时间必须早于结束时间` };
  if (e - s < MIN_DURATION) return { error: `${label}至少需要 ${MIN_DURATION / 60} 小时` };
  return { start, end };
}

// 整理一份规整的时间表（缺项/格式不对的退回默认值）
function normalizeTimes(raw) {
  const out = { overrides: {} };
  SLOT_KEYS.forEach((k) => {
    const t = raw && raw[k];
    out[k] = (t && toMinutes(t.start) !== null && toMinutes(t.end) !== null)
      ? { start: normHM(t.start), end: normHM(t.end) }
      : { ...DEFAULT_TIMES[k] };
  });
  const ov = raw && raw.overrides;
  if (ov && typeof ov === 'object') {
    Object.keys(ov).forEach((date) => {
      const day = ov[date];
      if (!day || typeof day !== 'object') return;
      const clean = {};
      SLOT_KEYS.forEach((k) => {
        const t = day[k];
        if (t && toMinutes(t.start) !== null && toMinutes(t.end) !== null) {
          clean[k] = { start: normHM(t.start), end: normHM(t.end) };
        }
      });
      if (Object.keys(clean).length) out.overrides[date] = clean;
    });
  }
  return out;
}

function rangeOf(t) {
  return `${t.start}-${t.end}`;
}

// 某一天某个时段的有效时间：单日覆盖优先，没有就用全局的
function effectiveTime(times, date, slot) {
  const day = times && times.overrides && times.overrides[date];
  const ov = day && day[slot];
  if (ov && toMinutes(ov.start) !== null && toMinutes(ov.end) !== null) return ov;
  return times[slot];
}

// 两段时间是否重叠（[start, end) 半开区间，相邻不算重叠）
function overlaps(a, b) {
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}

// 读配置文档。文档还不存在时退回默认值（首次使用前就是这个样子）
async function readSlotTimes() {
  try {
    const res = await db.collection('timeSlots').doc(CONFIG_DOC_ID).get();
    return normalizeTimes(res && res.data);
  } catch (e) {
    // 文档不存在（-502003）等情况都按「还没配置过」处理
    return normalizeTimes(null);
  }
}

// 写配置文档。整篇覆盖——这篇文档只归它自己用，没有别人往里写东西。
async function writeSlotTimes(times) {
  await db.collection('timeSlots').doc(CONFIG_DOC_ID).set({
    data: {
      morning: times.morning,
      afternoon: times.afternoon,
      evening: times.evening,
      overrides: times.overrides || {},
      updateTime: db.serverDate(),
    },
  });
}

// 云函数运行时区不保证是东八区，统一按 UTC+8 计算「今天」
function beijingToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// 同步还没完成的预约的 slotName。
//
// 只按 status 单字段过滤（复合条件查询要数据库索引，仓库里 sweepOverdue 也是这么写的），
// 日期和时段在内存里筛。命中的逐条改——条数很少（一个化妆师的待办），
// 逐条改比 where().update() 可控，也不会误伤别的记录。
//
// **每条预约按它自己那天的有效时间段写**：某天有单日覆盖时，那天的预约要写覆盖值，
// 不能跟着全局值走。
//
// dateFilter 为 null 表示「今天及以后的所有日期」，给一个日期则只处理那一天。
async function syncBookings(slot, times, dateFilter) {
  const today = beijingToday();
  let res;
  try {
    res = await db.collection('bookings')
      .where({ status: db.command.in(['pending', 'confirmed']) })
      .limit(100)
      .get();
  } catch (e) {
    console.warn('syncBookings 查询失败:', e.message);
    return 0;
  }
  const targets = (res.data || []).filter(b => (
    b.slot === slot
    && b.date >= today
    && (!dateFilter || b.date === dateFilter)
  ));
  let n = 0;
  for (const b of targets) {
    const range = rangeOf(effectiveTime(times, b.date, slot));
    if (b.slotName === range) continue;
    try {
      await db.collection('bookings').doc(b._id).update({
        data: { slotName: range, updateTime: db.serverDate() },
      });
      n++;
    } catch (e) {
      console.warn('syncBookings 更新失败', b._id, e.message);
    }
  }
  return n;
}

// 把 overrides 里已经过去的日期剪掉，文档不会无限膨胀
function pruneOverrides(overrides) {
  const today = beijingToday();
  const out = {};
  Object.keys(overrides || {}).forEach((date) => {
    if (date >= today) out[date] = overrides[date];
  });
  return out;
}

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  const action = (event && event.action) || 'get';

  try {
    // ============ 读取当前配置 ============
    if (action === 'get') {
      const times = await readSlotTimes();
      return {
        success: true,
        slotTimes: times,
        defaults: DEFAULT_TIMES,
      };
    }

    // ============ 改全局默认（三段一起改）============
    if (action === 'set') {
      const raw = (event && event.times) || {};
      const next = {};
      for (const k of SLOT_KEYS) {
        const r = parseRange(raw[k], SLOT_LABELS[k]);
        if (r.error) return { success: false, message: r.error };
        next[k] = { start: r.start, end: r.end };
      }
      // 三段之间不能重叠，否则顾客可能同时约到两个时段
      for (let i = 0; i < SLOT_KEYS.length; i++) {
        for (let j = i + 1; j < SLOT_KEYS.length; j++) {
          if (overlaps(next[SLOT_KEYS[i]], next[SLOT_KEYS[j]])) {
            return {
              success: false,
              message: `${SLOT_LABELS[SLOT_KEYS[i]]}和${SLOT_LABELS[SLOT_KEYS[j]]}的时间不能重叠`,
            };
          }
        }
      }

      const current = await readSlotTimes();
      const times = {
        ...next,
        overrides: pruneOverrides(current.overrides),
      };

      // 全局改了以后，已有的单日覆盖可能跟新全局时间撞车（比如某天上午覆盖到
      // 11:00-13:00，全局下午改成了 12:00-15:00，那天下午就和上午重叠了）。
      // 逐日校验，冲突就拒绝保存——宁可让她先改掉那一天，也不留一个坏配置。
      const conflicts = [];
      Object.keys(times.overrides).forEach((date) => {
        const dayTimes = {};
        for (const k of SLOT_KEYS) dayTimes[k] = effectiveTime(times, date, k);
        for (let i = 0; i < SLOT_KEYS.length; i++) {
          for (let j = i + 1; j < SLOT_KEYS.length; j++) {
            if (overlaps(dayTimes[SLOT_KEYS[i]], dayTimes[SLOT_KEYS[j]])) {
              conflicts.push(`${date} 的${SLOT_LABELS[SLOT_KEYS[i]]}和${SLOT_LABELS[SLOT_KEYS[j]]}`);
            }
          }
        }
      });
      if (conflicts.length) {
        return {
          success: false,
          message: `新时间和已单独调整的日期冲突：${conflicts.join('；')}。请先在课程表里改掉那几天的时间`,
        };
      }

      await writeSlotTimes(times);

      // 同步还没完成的预约：只有时间段真的变了才动
      let synced = 0;
      for (const k of SLOT_KEYS) {
        if (rangeOf(current[k]) === rangeOf(next[k])) continue;
        synced += await syncBookings(k, times, null);
      }

      return { success: true, message: '时间已保存', slotTimes: times, synced };
    }

    // ============ 单日覆盖：某天某时段单独改 ============
    if (action === 'setDate' || action === 'clearDate') {
      const date = event && event.date;
      const slot = event && event.slot;
      if (!date || !slot) return { success: false, message: '参数不完整' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { success: false, message: '日期格式不正确' };
      if (!SLOT_KEYS.includes(slot)) return { success: false, message: '无效时段' };

      const times = await readSlotTimes();

      if (action === 'clearDate') {
        const day = times.overrides[date];
        if (!day || !day[slot]) {
          return { success: true, message: '该日期本来就是默认时间', slotTimes: times, time: times[slot] };
        }
        delete day[slot];
        if (!Object.keys(day).length) delete times.overrides[date];
        await writeSlotTimes(times);
        const synced = await syncBookings(slot, times, date);
        return { success: true, message: '已恢复默认时间', slotTimes: times, time: times[slot], synced };
      }

      const r = parseRange(event.time, SLOT_LABELS[slot]);
      if (r.error) return { success: false, message: r.error };
      const next = { start: r.start, end: r.end };

      // 这一天的三段有效时间（当天其他时段的单日覆盖也要算进去），不能互相重叠
      const dayTimes = {};
      for (const k of SLOT_KEYS) {
        dayTimes[k] = effectiveTime(times, date, k);
      }
      dayTimes[slot] = next;
      for (let i = 0; i < SLOT_KEYS.length; i++) {
        for (let j = i + 1; j < SLOT_KEYS.length; j++) {
          if (overlaps(dayTimes[SLOT_KEYS[i]], dayTimes[SLOT_KEYS[j]])) {
            return {
              success: false,
              message: `${SLOT_LABELS[SLOT_KEYS[i]]}和${SLOT_LABELS[SLOT_KEYS[j]]}的时间不能重叠`,
            };
          }
        }
      }

      if (!times.overrides[date]) times.overrides[date] = {};
      times.overrides[date][slot] = next;
      times.overrides = pruneOverrides(times.overrides);
      await writeSlotTimes(times);

      const synced = await syncBookings(slot, times, date);
      return { success: true, message: '已保存这一天的时间', slotTimes: times, time: next, synced };
    }

    return { success: false, message: '无效操作' };
  } catch (err) {
    console.error('adminSlotTimes error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};
