const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 每天3个时段
const SLOT_KEYS = ['morning', 'afternoon', 'evening'];
const SLOT_NAMES = { morning: '09:30-11:30', afternoon: '14:00-17:00', evening: '18:00-21:00' };

const MAX = { name: 20, skinType: 200, remark: 500, styleName: 20 };

// 预约前置条件：个人信息必须填写完整。
// 前端同样有一份规则（miniprogram/utils/profileInfo.js），两边都要改。
// 这里必须有：只靠前端校验等于没有校验，客户端能绕过。
// 签名只收 nickname 与 info，不收整个文档——避免把文档当 info 传进来那种错法。
function missingProfileFields(nickname, info) {
  const i = info || {};
  const missing = [];
  if (!nickname) missing.push('昵称');
  if (!i.gender) missing.push('性别');
  if (!i.skinType) missing.push('肤质');
  if (i.skinType === '敏感性' && !i.sensitiveLevel) missing.push('敏感性程度');
  if (!i.hasAcne) missing.push('大面积爆痘');
  if (!i.hasCosmeticSurgery) missing.push('整容/医美');
  if (!i.hasAllergy) missing.push('化妆品/发品过敏');
  if (i.hasAllergy === '有' && !i.allergyNote) missing.push('过敏说明');
  if (!Array.isArray(i.photos) || i.photos.length < 1) missing.push('素颜照');
  return missing;
}

// 读本人资料；集合或文档不存在时返回 null（区别于“没取到身份”）
async function readUserDoc(openid) {
  try {
    const res = await db.collection('users').doc(openid).get();
    return res.data || null;
  } catch (err) {
    const text = [err.errMsg, err.message].filter(Boolean).join(' | ');
    // 集合/文档不存在都按“没有资料”处理，交给上层报缺项
    if (/-502005|-502003/.test(text) || /not exist/i.test(text)) return null;
    throw err;
  }
}

// 时段结束时刻（本地 24 小时制）：上午 11 点后 / 下午 17 点后 / 晚上 21 点后
// 与前端 utils/slots.js 的 SLOT_END_HOUR 是同一套规则，改一处要改两处
const SLOT_END_HOUR = { morning: 11, afternoon: 17, evening: 21 };

// 云函数运行时区不保证是东八区，统一按 UTC+8 计算「今天」和当前小时
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    hour: d.getUTCHours(),
  };
}

function todayStr(offsetDays) {
  const now = beijingNow();
  const [y, m, d] = now.date.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  if (offsetDays) base.setUTCDate(base.getUTCDate() + offsetDays);
  const p = n => String(n).padStart(2, '0');
  return `${base.getUTCFullYear()}-${p(base.getUTCMonth() + 1)}-${p(base.getUTCDate())}`;
}

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
  const { date, slot, name, skinType, remark, styleName } = event;
  const openid = currentOpenid(context);

  // 顾客端不再需要密码，身份由 openid 决定
  if (!openid) {
    let wxCtx = {};
    try {
      wxCtx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
    } catch (e) {}
    console.error('createBooking: 未取到 openid',
      '| cloud.getWXContext() =', JSON.stringify(wxCtx),
      '| context keys =', JSON.stringify(Object.keys(context || {})));
    return {
      success: false,
      code: 'NO_OPENID',
      message: '服务端未获取到用户身份（openid 为空）。'
        + '请确认：①微信开发者工具右上角已登录微信账号；'
        + '②本云函数已重新部署到小程序 app.js 中配置的那个云环境。',
    };
  }

  if (!date || !slot || !name) {
    return { success: false, message: '参数不完整' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, message: '日期格式不正确' };
  }
  if (!SLOT_KEYS.includes(slot)) {
    return { success: false, message: '无效时段' };
  }

  // 禁止预约过去的日期（服务端强校验，不依赖客户端时钟）
  if (date < todayStr(0)) {
    return { success: false, message: '不能预约已过去的日期' };
  }

  // 禁止预约当天已过结束时刻的时段（如上午 10 点不能再约 09:30-11:30）。
  // 前端也会置灰，但客户端能绕过，必须服务端兜底。
  const now = beijingNow();
  const endHour = SLOT_END_HOUR[slot];
  if (endHour !== undefined && date === now.date && now.hour >= endHour) {
    return { success: false, message: `该时段（${SLOT_NAMES[slot]}）已过时，无法预约` };
  }

  const cleanName = String(name).trim();
  const cleanSkin = String(skinType).trim();
  const cleanRemark = String(remark || '').trim();
  const cleanStyleName = String(styleName || '').trim();
  if (cleanStyleName.length > MAX.styleName) return { success: false, message: `妆造名称不能超过 ${MAX.styleName} 个字` };
  if (!cleanName) return { success: false, message: '请填写姓名' };
  if (cleanName.length > MAX.name) return { success: false, message: `昵称不能超过 ${MAX.name} 个字` };
  if (cleanSkin.length > MAX.skinType) return { success: false, message: `肤质描述不能超过 ${MAX.skinType} 个字` };
  if (cleanRemark.length > MAX.remark) return { success: false, message: `备注不能超过 ${MAX.remark} 个字` };

  // 个人信息必须完整（服务端强校验，与前端 utils/profileInfo.js 规则一致）
  const userDoc = await readUserDoc(openid);
  const missing = missingProfileFields(userDoc && userDoc.nickname, userDoc && userDoc.info);
  if (missing.length) {
    return {
      success: false,
      code: 'PROFILE_INCOMPLETE',
      missing,
      message: `请先补全个人信息：${missing.join('、')}`,
    };
  }

  // 同一时段不允许重复预约（pending / confirmed 都算占用）
  const dup = await db.collection('bookings').where({
    _openid: openid,
    date,
    slot,
    status: db.command.in(['pending', 'confirmed']),
  }).limit(1).get();
  if (dup.data && dup.data.length > 0) {
    return { success: false, message: '你已经预约过该时段，请勿重复提交' };
  }

  try {
    // 先确认该日期有时段配置，且目标时段存在
    const slotRes = await db.collection('timeSlots').where({ date }).limit(1).get();
    const slotDoc = slotRes.data && slotRes.data[0];
    if (!slotDoc) {
      return { success: false, message: '未找到该日期的时段数据，请联系化妆师开启预约' };
    }
    const slotData = slotDoc[slot];
    if (!slotData || !slotData.open) {
      return { success: false, message: `该时段（${SLOT_NAMES[slot]}）未开放预约` };
    }

    // 服务端校验所选妆造确实在该时段的开放列表中，价格以服务端配置为准
    const styleList = Array.isArray(slotData.styles) ? slotData.styles : [];
    let finalStyleName = '';
    let finalPrice = 0;
    if (cleanStyleName) {
      const matched = styleList.find(s => s && s.name === cleanStyleName);
      if (!matched) {
        return { success: false, message: '所选妆造已不在该时段的开放列表中，请重新选择' };
      }
      finalStyleName = matched.name;
      finalPrice = Number(matched.price) || 0;
    } else if (styleList.length > 0) {
      return { success: false, message: '请选择要画的妆造' };
    }

    // 原子占用：条件更新（单文档更新本身是原子的），避免并发重复预约
    const claim = await db.collection('timeSlots').where({
      _id: slotDoc._id,
      [`${slot}.open`]: true,
      [`${slot}.booked`]: false,
    }).update({ data: { [`${slot}.booked`]: true, [`${slot}.done`]: false } });

    if (claim.stats.updated !== 1) {
      return { success: false, message: `该时段（${SLOT_NAMES[slot]}）刚被预约，请刷新后重试` };
    }

    let createRes;
    try {
      createRes = await db.collection('bookings').add({
        data: {
          _openid: openid,
          date,
          slot,
          slotName: SLOT_NAMES[slot],
          name: cleanName,
          skinType: cleanSkin,
          remark: cleanRemark,
          styleName: finalStyleName,
          stylePrice: finalPrice,
          status: 'pending',
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
      });
    } catch (addErr) {
      // 写入失败必须回滚占用，否则时段被永久锁死
      await db.collection('timeSlots').doc(slotDoc._id).update({
        data: { [`${slot}.booked`]: false }
      });
      throw addErr;
    }

    return {
      success: true,
      bookingId: createRes._id,
      message: '预约提交成功，等待化妆师确认'
    };
  } catch (err) {
    console.error('createBooking error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};