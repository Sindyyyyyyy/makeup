// pages/adminSlots/adminSlots.js - 时段管理页（现在只是外壳）
// 课程表本体在 components/scheduleGrid，后台首页 adminPanel 用的是同一份。
// 这里保留标题栏 / 未登录提示 / 返回，onShow 与下拉刷新转交给组件。
const { isLoggedIn, clearAdmin } = require('../../utils/role.js');

Page({
  data: {
    isAdmin: false,
  },

  onLoad() {
    this.setData({ isAdmin: isLoggedIn() });
  },

  onShow() {
    if (this.data.isAdmin) {
      // withStyles：从「妆容管理」返回时快捷妆造可能已增减，要连妆造库一起重拉
      this.reloadGrid({ withStyles: true });
    }
  },

  onPullDownRefresh() {
    if (this.data.isAdmin) {
      this.reloadGrid().then(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  // 组件可能还没渲染完（未登录分支时它不存在），取不到就当无事发生
  reloadGrid(opts) {
    const c = this.selectComponent('#scheduleGrid');
    return c ? c.reload(opts) : Promise.resolve();
  },

  // 组件发现令牌失效：清掉已作废的本地身份，切到未登录提示。
  // 用 clearAdmin 而不是 removeStorageSync——role.js 是登录状态的唯一来源。
  handleAuthFail() {
    clearAdmin();
    this.setData({ isAdmin: false });
  },

  goBack() {
    wx.navigateBack();
  },
});
