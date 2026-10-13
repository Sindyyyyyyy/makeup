// 订阅消息（一次性订阅）模板与授权入口。
//
// 模板 ID 来自 公众平台 → 小程序 → 订阅消息 → 我的模板。
// 云函数侧各抄一份同样的常量（按仓库约定不共享模块，miniprogram/utils 也不在
// 云函数的文件系统里），所以改模板 ID 要同时改三处云函数：
// createBooking / adminUpdateBooking / cancelBooking。
//
// 注意：改模板字段时必须同步改各云函数 data 里的 key —— key 是平台分配的，
// 改字段名/加减字段而不同步代码，消息会静默发不出去（47003/47004），
// 而且**不会**有任何报错暴露给用户，只出现在云函数日志里。
const TPL_CUSTOMER_RESULT = 'L-Esvcae2XxxhLhogHY0dP5d_NUCpOw4rEcBNZB4u3A';  // 化妆师确认/拒绝 → 顾客
const TPL_ARTIST_NEW = 'OE7Sj4rWPKUfCvreIfadWG5r3SPAmxGjgGGhJt9WG4E';        // 顾客新预约 → 化妆师
const TPL_ARTIST_CANCELLED = 'fBtVJqD7Ur_ERJ7y78L46MRXtX7n4R_SS4448hvqPIE';  // 顾客取消 → 化妆师

// 通知点开后跳回首页。tabBar 首页 100% 存在于任何已发布版本，天然免疫 41030。
// 路径不带前导斜杠，且必须与 app.json 的注册项逐字一致。
const PAGE_HOME = 'pages/index/index';

// 拉起微信的订阅授权弹窗。
//
// tmplIds 一次最多传 3 个，每个模板各得 1 次发送额度（用户点「允许」才作数，
// 每成功发一条扣 1，额度为 0 时再发就是 43101）。
//
// 必须由用户点击手势触发：把本函数当作某个 tap 处理器里的第一段 await 来用，
// 不要放进 load / onShow / 网络回调里，会报
// can only be invoked by user TAP action。
//
// 用户点「取消」或系统弹窗失败都走 fail：这里一律 resolve(null) 当成「没授权」，
// 继续主流程 —— 拒绝订阅只是收不到消息，绝不能因此中断下单/取消。
function requestSubscribe(tmplIds) {
  const ids = (tmplIds || []).filter(Boolean);
  // 某个模板 ID 暂时为空（还没申请/被删）时跳过它，其余照常弹。
  // 这样即使三个模板没配齐，预约流程也不受影响。
  if (!ids.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: (res) => resolve(res || {}),
      fail: (err) => {
        console.warn('requestSubscribeMessage failed', err);
        resolve(null);
      },
    });
  });
}

module.exports = {
  TPL_CUSTOMER_RESULT,
  TPL_ARTIST_NEW,
  TPL_ARTIST_CANCELLED,
  PAGE_HOME,
  requestSubscribe,
};