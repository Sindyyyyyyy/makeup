const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 兼容取 openid：优先官方 API cloud.getWXContext()，回退到 main 的 context 参数
function currentOpenid(context) {
  let wxCtx = {};
  try {
    wxCtx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
  } catch (e) {
    wxCtx = {};
  }
  return (wxCtx && wxCtx.OPENID) || (context && context.OPENID) || null;
}

exports.main = async (event, context) => {
  const { bookingId } = event;
  // openid 只能取自服务端，绝不接受客户端传入，否则可被伪造
  const openid = currentOpenid(context);

  if (!bookingId) {
    return { success: false, message: '缺少预约ID' };
  }

  try {
    let bookingRes;
    try {
      bookingRes = await db.collection('bookings').doc(bookingId).get();
    } catch (e) {
      return { success: false, message: '预约不存在' };
    }
    const booking = bookingRes.data;
    if (!booking) {
      return { success: false, message: '预约不存在' };
    }

    // 归属校验：任何人拿到 bookingId 都不能取消他人预约
    if (!openid) {
      console.error('cancelBooking: 未取到 openid, context keys =',
        JSON.stringify(Object.keys(context || {})));
      return {
        success: false,
        code: 'NO_OPENID',
        message: '服务端未获取到用户身份，无法校验预约归属。'
          + '请确认开发者工具已登录微信账号，且云函数已重新部署。',
      };
    }
    if (booking._openid !== openid) {
      return { success: false, message: '无权取消该预约' };
    }

    if (!['pending', 'confirmed'].includes(booking.status)) {
      return { success: false, message: '该预约当前状态不可取消' };
    }

    const updateRes = await db.collection('bookings').where({
      _id: bookingId,
      status: booking.status,
    }).update({
      data: {
        status: 'cancelled',
        updateTime: db.serverDate()
      }
    });
    if (updateRes.stats.updated === 0) {
      return { success: false, message: '操作失败，预约状态已变化，请刷新后重试' };
    }

    // 释放时段（只针对该日期的那一条记录）
    const slotRes = await db.collection('timeSlots').where({ date: booking.date }).limit(1).get();
    const slotDoc = slotRes.data && slotRes.data[0];
    if (slotDoc) {
      await db.collection('timeSlots').doc(slotDoc._id).update({
        data: { [`${booking.slot}.booked`]: false }
      });
    }

    return { success: true, message: '预约已取消' };
  } catch (err) {
    console.error('cancelBooking error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};