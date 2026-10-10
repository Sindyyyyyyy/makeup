const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const MAX_DATES = 31;

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