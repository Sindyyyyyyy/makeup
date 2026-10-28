// utils/slots.js - 前后端共用的时段/日期定义（唯一来源）
//
// 时段的时间**不再是写死的**：权威值存在数据库里（timeSlots 集合中 _id='slot_times'
// 的那篇配置文档），这里只保留「数据库里还没配置过」时的兜底默认值。
// 化妆师改作息不用改代码、不用重新部署。
//
// 有效时间的解析规则（前后端各一份，规则必须一致）：
//   effective(date, slot) = overrides[date][slot] ?? 全局的 slot
// 单日覆盖优先，没有就用全局默认。

// 兜底默认值：只在配置文档还不存在时才会被用到
const DEFAULT_SLOT_TIMES = {
  morning: { start: '09:30', end: '11:30' },
  afternoon: { start: '14:00', end: '17:00' },
  evening: { start: '18:00', end: '21:00' },
};

// 三个时段的 key 和中文名。time（时间）不再写死，由配置决定。
const SLOT_DEFS = [
  { key: 'morning', name: '上午' },
  { key: 'afternoon', name: '下午' },
  { key: 'evening', name: '晚上' },
];

// 时段先后顺序，用于「越晚越靠上」这类排序
const SLOT_ORDER = { morning: 0, afternoon: 1, evening: 2 };

const DOW_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const STATUS_TEXT = {
  pending: '待确认',
  confirmed: '已确认',
  cancelled: '已取消',
  rejected: '已拒绝',
  completed: '已完成',
};

// 时间段字符串统一是 'HH:MM-HH:MM'（**一个**连字符）。
// 订阅消息的 fmtTime / fmtDateTime 用 split('-')[0] 取开始时间，
// 多一个连字符就会取错，改格式前先看那三处。
function formatRange(t) {
  if (!t || !t.start || !t.end) return '';
  return `${t.start}-${t.end}`;
}

// 'HH:MM' → 从 00:00 起的分钟数。格式不对返回 null。
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// 'H:MM' → 'HH:MM'（picker 给的时间小时可能不带前导 0）
function normHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return '';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

// 兜底的时段名映射（key → 时间段字符串）。
// 预约文档自带的 slotName 才是权威值，这里只是它缺失时的退路。
const SLOT_NAMES = {
  morning: formatRange(DEFAULT_SLOT_TIMES.morning),
  afternoon: formatRange(DEFAULT_SLOT_TIMES.afternoon),
  evening: formatRange(DEFAULT_SLOT_TIMES.evening),
};
const SLOT_NAME_MAP = SLOT_NAMES;

// 把服务端返回的配置整理成一份规整的时间表：
//   { morning:{start,end}, afternoon:{...}, evening:{...},
//     overrides: { 'YYYY-MM-DD': { morning:{start,end} } } }
// 缺项/格式不对的地方一律退回默认值，保证前端永远拿到能渲染的东西。
function normalizeSlotTimes(raw) {
  const out = { overrides: {} };
  SLOT_DEFS.forEach((s) => {
    const t = raw && raw[s.key];
    out[s.key] = (t && toMinutes(t.start) !== null && toMinutes(t.end) !== null)
      ? { start: normHM(t.start), end: normHM(t.end) }
      : { ...DEFAULT_SLOT_TIMES[s.key] };
  });
  const ov = raw && raw.overrides;
  if (ov && typeof ov === 'object') {
    Object.keys(ov).forEach((date) => {
      const day = ov[date];
      if (!day || typeof day !== 'object') return;
      const clean = {};
      SLOT_DEFS.forEach((s) => {
        const t = day[s.key];
        if (t && toMinutes(t.start) !== null && toMinutes(t.end) !== null) {
          clean[s.key] = { start: normHM(t.start), end: normHM(t.end) };
        }
      });
      if (Object.keys(clean).length) out.overrides[date] = clean;
    });
  }
  return out;
}

// 某一天某个时段的有效时间：单日覆盖优先，没有就用全局的
function resolveSlotTime(slotTimes, date, slot) {
  const base = (slotTimes && slotTimes[slot]) || DEFAULT_SLOT_TIMES[slot];
  const day = slotTimes && slotTimes.overrides && slotTimes.overrides[date];
  const ov = day && day[slot];
  if (ov && toMinutes(ov.start) !== null && toMinutes(ov.end) !== null) return ov;
  return base;
}

// 这个格子的时间是不是被单独改过（和全局默认不一样）
function isCustomTime(slotTimes, date, slot) {
  const t = resolveSlotTime(slotTimes, date, slot);
  const d = (slotTimes && slotTimes[slot]) || DEFAULT_SLOT_TIMES[slot];
  return t.start !== d.start || t.end !== d.end;
}

// 课程表的三行标题。WXML 不能调用 JS 函数，所以整行都要进 data。
function buildSlotRows(slotTimes) {
  return SLOT_DEFS.map((s, i) => ({
    ...s,
    _idx: i,
    time: formatRange((slotTimes && slotTimes[s.key]) || DEFAULT_SLOT_TIMES[s.key]),
  }));
}

// 该时段是否已经过去（dateStr 为 YYYY-MM-DD；endTime 为 'HH:MM'；now 缺省取设备当前时间）
//
// 结束时刻来自配置（有效时间的 end），不再是写死的整数小时——
// 原来 SLOT_END_HOUR 上午写 11 点、实际时段到 11:30，白白少卖半小时。
function isSlotExpired(dateStr, endTime, now) {
  const end = toMinutes(endTime);
  if (end === null) return false;
  const cur = now || new Date();
  const today = formatDate(cur);
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return cur.getHours() * 60 + cur.getMinutes() >= end;
}

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 根据周偏移计算周一~周日 7 天的日期信息
function computeWeekDates(weekOffset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - dow + (weekOffset || 0) * 7);
  const todayStr = formatDate(today);

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = formatDate(d);
    weekDates.push({
      date: dateStr,
      dow: DOW_LABELS[i],
      dateLabel: `${d.getMonth() + 1}/${d.getDate()}`,
      isToday: dateStr === todayStr,
      isPast: dateStr < todayStr,
      _idx: i,
    });
  }
  return weekDates;
}

module.exports = {
  SLOT_DEFS,
  SLOT_NAMES,
  SLOT_NAME_MAP,
  SLOT_ORDER,
  DEFAULT_SLOT_TIMES,
  DOW_LABELS,
  STATUS_TEXT,
  formatRange,
  toMinutes,
  normHM,
  normalizeSlotTimes,
  resolveSlotTime,
  isCustomTime,
  buildSlotRows,
  formatDate,
  isSlotExpired,
  computeWeekDates,
};
