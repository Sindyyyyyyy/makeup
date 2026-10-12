// utils/slots.js - 前后端共用的时段/日期定义（唯一来源）
const SLOT_DEFS = [
  { key: 'morning', name: '上午', time: '8:00-11:00' },
  { key: 'afternoon', name: '下午', time: '14:00-17:00' },
  { key: 'evening', name: '晚上', time: '18:00-21:00' },
];

const SLOT_NAMES = { morning: '8-11点', afternoon: '14-17点', evening: '18-21点' };
const SLOT_NAME_MAP = SLOT_NAMES;

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

// 时段结束时刻（本地 24 小时制），上午 11 点后 / 下午 17 点后 / 晚上 21 点后
// 前后端各有一份判定（前端 utils/slots.js，服务端 createBooking），规则必须一致
const SLOT_END_HOUR = { morning: 11, afternoon: 17, evening: 21 };

// 该时段是否已经过去（dateStr 为 YYYY-MM-DD；now 缺省取设备当前时间）
function isSlotExpired(dateStr, slotKey, now) {
  const endHour = SLOT_END_HOUR[slotKey];
  if (endHour === undefined) return false;
  const cur = now || new Date();
  const today = formatDate(cur);
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return cur.getHours() >= endHour;
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
  SLOT_END_HOUR,
  DOW_LABELS,
  STATUS_TEXT,
  formatDate,
  isSlotExpired,
  computeWeekDates,
};