const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const MAX_DATES = 31;

// ============ 时段配置 ============
// 权威值在 timeSlots 集合的 _id='slot_times' 文档里：
//   { morning:{start,end}, afternoon:{...}, evening:{...},
//     overrides: { 'YYYY-MM-DD': { morning:{start,end} } } }
// 有效时间 = overrides[date][slot] ?? 全局的 slot。
// 与 miniprogram/utils/slots.js 是同一套规则（两个目录不共享文件系统，只能各抄一份）。
//
// 顾客端一次 listWeekSchedule 就把配置带回去——不为了取时间再多打一次云函数调用
// （免费额度每月 20 万次，不能随便花）。文档里的库读不占额度。
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


// 过期预约的自动结算已挪到定时触发的 sweepOverdue 云函数，
// 这里的读取路径不再做任何写操作。

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
    // 时段开放情况属于公共数据
    const tsRes = await db.collection('timeSlots')
      .where({ date: db.command.in(clean) })
      .get();

    // 我的预约只能查自己的，服务端强制注入 _openid。
    // 返回完整文档：首页的网格和「我的预约」卡片都由这一份数据渲染，
    // 不需要再单独调一次 listMyBookings（那次调用也跑一遍全表结算，是主要开销来源）。
    let myBookings = [];
    if (openid) {
      const bkRes = await db.collection('bookings').where({
        _openid: openid,
      })
        // 只按日期倒序取；同一天内的时段先后（晚上→下午→上午）由客户端按
        // SLOT_ORDER 排，数据库 orderBy('slot') 是字母序，顺序不对
        .orderBy('date', 'desc')
        .limit(50)
        .get();
      myBookings = bkRes.data;
    }

    return { success: true, timeSlots: tsRes.data, myBookings, slotTimes: await readSlotTimes() };
  } catch (err) {
    console.error('listWeekSchedule error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};