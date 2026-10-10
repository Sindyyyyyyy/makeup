const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const SLOT_KEYS = ['morning', 'afternoon', 'evening'];
const SLOT_NAMES = { morning: '8-11点', afternoon: '14-17点', evening: '18-21点' };

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

  const { date, slot, action } = event;

  if (!date || !slot || !action) {
    return { success: false, message: '参数不完整' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, message: '日期格式不正确' };
  }
  if (!SLOT_KEYS.includes(slot)) {
    return { success: false, message: '无效时段' };
  }
  if (!['open', 'close'].includes(action)) {
    return { success: false, message: '无效操作' };
  }

  try {
    const open = action === 'open';

    // 查找是否已有该日期记录
    const existing = await db.collection('timeSlots').where({ date }).limit(1).get();
    const record = existing.data && existing.data[0];

    if (record) {
      const current = record[slot];
      const isBooked = !!(current && current.booked);

      // 关闭时若该时段仍有预约，释放 booked 会造成重复预约，必须拦截
      if (!open && isBooked) {
        return {
          success: false,
          message: `该时段（${SLOT_NAMES[slot]}）已有预约，请先在预约列表中取消或拒绝后再关闭`,
        };
      }

      await db.collection('timeSlots').doc(record._id).update({
        data: {
          [`${slot}.open`]: open,
          ...(open ? {} : { [`${slot}.booked`]: false }),
        }
      });
    } else {
      // 新建：其余时段默认关闭
      const initData = {
        date,
        morning: { open: false, booked: false },
        afternoon: { open: false, booked: false },
        evening: { open: false, booked: false }
      };
      initData[slot] = { open, booked: false };
      await db.collection('timeSlots').add({ data: initData });
    }

    const msg = open
      ? `已开放 ${SLOT_NAMES[slot]} 预约`
      : `已关闭 ${SLOT_NAMES[slot]} 预约`;
    return { success: true, message: msg };
  } catch (err) {
    console.error('adminSetTimeSlot error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};