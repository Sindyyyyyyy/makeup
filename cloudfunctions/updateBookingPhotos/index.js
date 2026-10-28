// updateBookingPhotos - 顾客修改**自己某一单**的「想画的妆容照片」
//
// 背景：参考图属于「单次预约」，不存个人资料（顾客每次想画的妆容大概率不同，
// 每下一单都要重新传）。图存在 bookings 文档的 styleRefPhotos 字段上。
// 顾客可以在首页「我的预约」卡片的「详细信息」里，像改素颜照一样改这些图，
// 所以需要一条「只改这一单、且只能改自己的」的写入路径。
//
// 身份只认 openid：cloud.getWXContext() 取，**绝不**从 event 里拿。
// 归属也在这里校验：doc._openid !== openid 一律拒绝。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 想画的妆容照片：最多 3 张。与 miniprogram/utils/profileInfo.js、
// cloudfunctions/createBooking/index.js 各抄一份
//（三个目录不共享文件系统，只能人工同步）。
const MAX_STYLE_REF_PHOTOS = 3;

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

// 只保留云存储 fileID，最多 3 张。
// 口径与 createBooking 的 normalizeStyleRefPhotos 一致：不合法的静默丢弃、不报错。
function normalizeStyleRefPhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p) => String(p || '').trim())
    .filter((p) => p.indexOf('cloud://') === 0)
    .slice(0, MAX_STYLE_REF_PHOTOS);
}

// ============ 界面语言 ============
// 客户端每次调用都带 lang。不认识的一律中文 —— 老版本客户端不带这个字段，
// 老版本云函数也不认识它，两个方向的失败模式都是「显示中文」，不会出错。
function normalizeLang(l) {
  return l === 'en' ? 'en' : 'zh';
}

// 按仓库约定这里不共享模块，各抄一份。
const MSG = {
  zh: {
    noIdentity: '服务端未获取到用户身份（openid 为空）。请确认微信开发者工具已登录微信账号，且本云函数已部署到小程序 app.js 配置的云环境。',
    badParams: '参数不完整',
    notFound: '预约不存在',
    notOwner: '无权修改该预约',
    finished: '该预约已结束，不能再修改',
    serverError: '保存失败，请重试',
  },
  en: {
    noIdentity: 'Server could not identify the user. Please make sure the DevTools is signed in and this function is deployed to the right cloud environment.',
    badParams: 'Missing parameters',
    notFound: 'Booking not found',
    notOwner: 'You are not allowed to modify this booking',
    finished: 'This booking has ended and can no longer be changed',
    serverError: 'Save failed, please retry',
  },
};

exports.main = async (event, context) => {
  const msg = MSG[normalizeLang(event && event.lang)];
  const openid = currentOpenid(context);
  if (!openid) {
    console.error('updateBookingPhotos: 未取到 openid');
    return { success: false, code: 'NO_OPENID', message: msg.noIdentity };
  }

  const bookingId = event && event.bookingId;
  if (!bookingId || typeof bookingId !== 'string') {
    return { success: false, message: msg.badParams };
  }

  try {
    const res = await db.collection('bookings').doc(bookingId).get();
    const doc = res.data;
    if (!doc) return { success: false, message: msg.notFound };
    // 只能改自己的预约
    if (doc._openid !== openid) return { success: false, message: msg.notOwner };
    // 只能改还没结束的预约：已完成/已取消/已拒绝的单改了也没有意义
    if (doc.status !== 'pending' && doc.status !== 'confirmed') {
      return { success: false, message: msg.finished };
    }

    const photos = normalizeStyleRefPhotos(event.styleRefPhotos);
    await db.collection('bookings').doc(bookingId).update({
      data: {
        styleRefPhotos: photos,
        updateTime: db.serverDate(),
      },
    });
    return { success: true, styleRefPhotos: photos };
  } catch (err) {
    const text = [err && err.errMsg, err && err.message].filter(Boolean).join(' | ');
    // 文档不存在：不是错误
    if (/-502003/.test(text) || /not exist/i.test(text)) {
      return { success: false, message: msg.notFound };
    }
    console.error('updateBookingPhotos error:', err);
    return { success: false, message: msg.serverError };
  }
};
