const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// ============ 时段配置 ============
// 权威值在 timeSlots 集合的 _id='slot_times' 文档里：
//   { morning:{start,end}, afternoon:{...}, evening:{...},
//     overrides: { 'YYYY-MM-DD': { morning:{start,end} } } }
// 与 miniprogram/utils/slots.js 是同一套规则（两个目录不共享文件系统，只能各抄一份）。
// 课程表组件靠它渲染行标题上的时间，也靠它知道哪一格被单独改过时间。
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

    // 配置文档（_id='slot_times'）没有 date 字段，日期区间查询本来就命中不到它；
    // 但不带日期区间时 where({}) 会把它一起捞出来，这里滤掉，免得客户端把
    // 一篇没有 date 的文档当成某一天。
    const slots = (res.data || []).filter(d => d && d.date);

    return { success: true, slots, slotTimes: await readSlotTimes() };
  } catch (err) {
    console.error('adminListSlots error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};