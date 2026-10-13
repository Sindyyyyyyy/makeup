// pages/adminLogin/adminLogin - 化妆师登录页
//
// 独立于首页 tab 的普通页：没有底部「首页 / 个人中心」菜单栏，只有左上角一个
// 返回箭头。顾客从个人中心点「化妆师入口」来到这里；已经登记过的化妆师会被
// 静默识别、直接进后台，只有真正需要时才问密码。
const { isLoggedIn, setMode, saveToken, refreshAdminToken } = require('../../utils/role.js');

Page({
  data: {
    // 自定义导航栏要用，避开胶囊按钮
    statusBarHeight: 20,
    navBarHeight: 44,
    passcode: '',
    loading: false,
    // 正在问服务端"我是不是化妆师"。这段时间不渲染密码框——
    // 否则已登记的化妆师每次进来都会看到密码框闪一下，正是本功能要消除的东西
    checking: true,
  },

  async onLoad() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.setData({ statusBarHeight: info.statusBarHeight || 20 });
    } catch (e) {
      // 拿不到就用默认值，布局不会塌
      console.warn('读取系统信息失败', e);
    }

    // 已经有令牌：直接回后台。过期了由后台面板静默重签，不在这里打断她
    if (isLoggedIn()) {
      this.toAdmin();
      return;
    }

    // 本地没令牌，但服务端可能还记着这个化妆师身份：静默试一次免密重签
    const r = await refreshAdminToken();
    if (r.ok) {
      this.toAdmin();
      return;
    }

    // 到这一步才确定要问密码
    this.setData({ checking: false });
  },

  // 已经有化妆师身份，直落后台
  toAdmin() {
    setMode('admin');
    wx.switchTab({ url: '/pages/index/index' });
  },

  onPwdInput(e) {
    this.setData({ passcode: e.detail.value });
  },

  // 返回顾客页面。注意用 switchTab：首页是 tab 页，navigateTo/navigateBack 到不了。
  // 没拿到令牌时顺手把模式复位，否则首页会一直停在后台那一侧。
  goBack() {
    if (!isLoggedIn()) setMode('customer');
    wx.switchTab({ url: '/pages/index/index' });
  },

  async login() {
    if (!this.data.passcode) {
      return wx.showToast({ title: '请输入密码', icon: 'none' });
    }
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminLogin',
        data: { password: this.data.passcode },
      });
      const r = res.result;
      if (r && r.success) {
        // 只保存令牌，不保存密码
        saveToken(r.token);
        this.setData({ passcode: '' });
        this.toAdmin();
        // 密码对了但身份没记上（多半是 users 集合没建），如实说一声，
        // 否则"下次又要输密码"会变成一个查不出原因的怪问题
        if (r.adminBound === false) {
          wx.showToast({ title: '未能保存化妆师身份', icon: 'none', duration: 3000 });
        }
      } else {
        wx.showToast({ title: (r && r.message) || '登录失败', icon: 'none' });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '登录失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
