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
    if (!this.data.isAdmin) return;
    // 只重拉时段表（实时状态，每次都要新）。妆造库由 styleCache 负责，见 reloadGrid 注释。
    this.reloadGrid();
  },

  onPullDownRefresh() {
    if (this.data.isAdmin) {
      this.reloadGrid().then(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  // 组件可能还没渲染完（未登录分支时它不存在），取不到就当无事发生。
  // 首次 navigateTo 时组件尚未 attached，这次调用是空操作，真正的首拉由
  // scheduleGrid.attached() 负责——不会重复发请求。
  reloadGrid() {
    const c = this.selectComponent('#scheduleGrid');
    return c ? c.reload() : Promise.resolve();
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
