const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const SLOT_KEYS = ['morning', 'afternoon', 'evening'];

// 状态机：仅允许的流转
const ACTION_MAP = {
  confirm: { from: ['pending'], to: 'confirmed' },
  reject: { from: ['pending'], to: 'rejected' },
  complete: { from: ['confirmed'], to: 'completed' },
};

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

  const { bookingId, action } = event;

  if (!bookingId || !action) {
    return { success: false, message: '参数不完整' };
  }
  const rule = ACTION_MAP[action];
  if (!rule) {
    return { success: false, message: '无效操作' };
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

    // 状态机校验：防止对已取消/已拒绝的预约重复操作
    if (!rule.from.includes(booking.status)) {
      return { success: false, message: `当前状态不可执行该操作（${booking.status}）` };
    }

    const updateRes = await db.collection('bookings').where({
      _id: bookingId,
      status: booking.status,
    }).update({
      data: {
        status: rule.to,
        updateTime: db.serverDate()
      }
    });
    if (updateRes.stats.updated === 0) {
      return { success: false, message: '操作失败，预约状态已变化，请刷新后重试' };
    }

    // 仅拒绝时释放时段；完成只做归档，保留占用记录以便追溯。
    // 完成时额外打上 done 标记，时段管理页据此显示「已完成」而不是「已预约」
    if (rule.to === 'rejected' || rule.to === 'completed') {
      const slotRes = await db.collection('timeSlots').where({ date: booking.date }).limit(1).get();
      const slotDoc = slotRes.data && slotRes.data[0];
      if (slotDoc) {
        const data = rule.to === 'rejected'
          ? { [`${booking.slot}.booked`]: false, [`${booking.slot}.done`]: false }
          : { [`${booking.slot}.done`]: true };
        await db.collection('timeSlots').doc(slotDoc._id).update({ data });
      }
    }

    const messages = { confirmed: '已确认预约', rejected: '已拒绝预约', completed: '已标记完成' };
    return { success: true, message: messages[rule.to] };
  } catch (err) {
    console.error('adminUpdateBooking error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};