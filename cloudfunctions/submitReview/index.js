// submitReview - 顾客评价**自己某一单**已完成的服务
//
// 背景：化妆师在后台把预约标记成「已完成」之后，顾客端应该能给这次服务写一条评价。
// 评价**挂在预约文档上**（bookings.review），不另建 reviews 集合：
//   · listWeekSchedule（顾客端）和 adminGetBookings（后台）都返回整条预约文档，
//     review 会自动跟着回包走 —— 页面判断「有没有评价过」一次云函数调用都不用多打；
//   · 不用手动去云开发控制台建集合（users 集合当初就是因为这个坑过）。
// 一单一条评价：再次提交就是「修改」，服务端覆盖同一条记录。
//
// 身份只认 openid：cloud.getWXContext() 取，**绝不**从 event 里拿。
// 归属也在这里校验：doc._openid !== openid 一律拒绝。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 评价正文最长字数。客户端 textarea 的 maxlength 也是 200，两边一致（服务端是硬约束）。
const MAX_REVIEW_LEN = 200;

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
    notOwner: '无权评价该预约',
    notReviewable: '只有已完成的预约才能评价',
    emptyReview: '评价内容不能为空',
    tooLong: '评价最多 ' + MAX_REVIEW_LEN + ' 字',
    serverError: '保存失败，请重试',
  },
  en: {
    noIdentity: 'Server could not identify the user. Please make sure the DevTools is signed in and this function is deployed to the right cloud environment.',
    badParams: 'Missing parameters',
    notFound: 'Booking not found',
    notOwner: 'You are not allowed to review this booking',
    notReviewable: 'Only completed bookings can be reviewed',
    emptyReview: 'The review cannot be empty',
    tooLong: 'A review can be at most ' + MAX_REVIEW_LEN + ' characters',
    serverError: 'Save failed, please retry',
  },
};

exports.main = async (event, context) => {
  const msg = MSG[normalizeLang(event && event.lang)];
  const openid = currentOpenid(context);
  if (!openid) {
    console.error('submitReview: 未取到 openid');
    return { success: false, code: 'NO_OPENID', message: msg.noIdentity };
  }

  const bookingId = event && event.bookingId;
  if (!bookingId || typeof bookingId !== 'string') {
    return { success: false, message: msg.badParams };
  }

  const content = String((event && event.content) || '').trim();
  if (!content) {
    return { success: false, message: msg.emptyReview };
  }
  if (content.length > MAX_REVIEW_LEN) {
    return { success: false, message: msg.tooLong };
  }

  try {
    const res = await db.collection('bookings').doc(bookingId).get();
    const doc = res && res.data;
    if (!doc) return { success: false, message: msg.notFound };
    // 只能评价自己的预约
    if (doc._openid !== openid) return { success: false, message: msg.notOwner };
    // 只能评价已完成的单。前端只给「已完成」的卡片显示评价按钮，
    // 但那只是第一层 —— 服务端这道才是硬约束（状态可能刚被 sweepOverdue 改过）。
    if (doc.status !== 'completed') {
      return { success: false, message: msg.notReviewable };
    }

    // 改评价时保留第一次评价的时间，只刷 updateTime。
    //
    // 这里用普通的 Date 而不是 db.serverDate()：仓库里 db.serverDate() 一律只出现在
    // data 的顶层字段，嵌在对象里（review.createTime）能不能被服务端识别没有先例可循，
    // 不拿线上数据赌。值是在云函数里算的，本来就是服务端时间。
    // 存进去是日期类型，读回来是 Date 对象，adminPanel.formatDateTime() 直接能格式化。
    const now = new Date();
    const prev = (doc.review && typeof doc.review === 'object') ? doc.review : null;
    const review = {
      content,
      createTime: (prev && prev.createTime) || now,
      updateTime: now,
    };
    await db.collection('bookings').doc(bookingId).update({
      data: {
        review,
        updateTime: db.serverDate(),
      },
    });

    // 只回传内容：客户端要做的只是把本地那一条补上 review.content，
    // 时间戳它用不上（后台那边是从库里原样读的），回传反而多一份要序列化的 Date。
    return { success: true, review: { content } };
  } catch (err) {
    const text = [err && err.errMsg, err && err.message].filter(Boolean).join(' | ');
    // 文档不存在：不是错误
    if (/-502003/.test(text) || /not exist/i.test(text)) {
      return { success: false, message: msg.notFound };
    }
    console.error('submitReview error:', err);
    return { success: false, message: msg.serverError };
  }
};
