const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  let wxCtx = {};
  try {
    wxCtx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
  } catch (e) {}
  const openid = (wxCtx && wxCtx.OPENID) || (context && context.OPENID) || null;
  console.log('listMyBookings called, openid:', openid, '| getWXContext:', JSON.stringify(wxCtx));

  if (!openid) {
    return { success: false, code: 'NO_OPENID', message: '未获取到用户身份' };
  }

  try {
    const res = await db.collection('bookings')
      .where({
        _openid: openid,
      })
      // 只按日期倒序取；同一天内的时段先后（晚上→下午→上午）由客户端按
      // SLOT_ORDER 排，数据库 orderBy('slot') 是字母序，顺序不对
      .orderBy('date', 'desc')
      .limit(50)
      .get();

    return {
      success: true,
      data: res.data,
    };
  } catch (err) {
    console.error('listMyBookings error:', err);
    return {
      success: false,
      message: err.message,
    };
  }
};
