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
      .orderBy('date', 'desc')
      .orderBy('slot', 'asc')
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
