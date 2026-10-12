const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const MAX_DATES = 31;

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

    return { success: true, timeSlots: tsRes.data, myBookings };
  } catch (err) {
    console.error('listWeekSchedule error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};