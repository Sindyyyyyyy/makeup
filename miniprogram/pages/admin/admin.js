// pages/admin/admin.js - 化妆师后台 v1.1.0
const { SLOT_NAME_MAP, STATUS_TEXT } = require('../../utils/slots.js');

const TOKEN_KEY = 'admin_token';

function formatDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

Page({
  data: {
    isAdmin: false,
    passcode: '',
    loading: false,
    bookings: [],
    filtered: [],
    stats: { pending: 0, confirmed: 0, completed: 0, rejected: 0, cancelled: 0 },
    filterStatus: 'all',
    statusText: STATUS_TEXT,
    page: 0,
    hasMore: false,
    // 顾客个人信息（只读查看）
    showUserProfile: false,
    userInfo: null,
    userNickname: '',
    userInfoHint: '',
  },

  onLoad() {
    // 只校验本地是否存在令牌，真正的鉴权在云函数
    if (wx.getStorageSync(TOKEN_KEY)) {
      this.setData({ isAdmin: true });
    }
  },

  onShow() {
    if (this.data.isAdmin) this.loadBookings();
  },

  onPullDownRefresh() {
    if (this.data.isAdmin) {
      this.loadBookings().then(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  onPwdInput(e) {
    this.setData({ passcode: e.detail.value });
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
      if (res.result && res.result.success) {
        // 只保存令牌，不保存密码
        wx.setStorageSync(TOKEN_KEY, res.result.token);
        this.setData({ isAdmin: true, passcode: '', page: 0 });
        await this.loadBookings();
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '登录失败', icon: 'none' });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '登录失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  logout() {
    wx.removeStorageSync(TOKEN_KEY);
    this.setData({
      isAdmin: false,
      passcode: '',
      bookings: [],
      filtered: [],
      page: 0,
      hasMore: false,
      stats: { pending: 0, confirmed: 0, completed: 0, rejected: 0, cancelled: 0 },
    });
  },

  async loadBookings(append = false) {
    const token = wx.getStorageSync(TOKEN_KEY);
    if (!token) {
      this.setData({ isAdmin: false });
      return;
    }
    try {
      const page = append ? this.data.page + 1 : 0;
      const res = await wx.cloud.callFunction({
        name: 'adminGetBookings',
        data: { token, page, pageSize: 50 },
      });
      if (res.result && res.result.success) {
        const mapped = res.result.bookings.map(b => ({
          ...b,
          slotLabel: SLOT_NAME_MAP[b.slot] || b.slot,
          createdAtText: formatDateTime(b.createTime),
        }));
        const bookings = append ? this.data.bookings.concat(mapped) : mapped;

        const stats = { pending: 0, confirmed: 0, completed: 0, rejected: 0, cancelled: 0 };
        bookings.forEach(b => {
          if (Object.prototype.hasOwnProperty.call(stats, b.status)) stats[b.status]++;
        });

        this.setData({
          isAdmin: true,
          bookings,
          stats,
          page,
          hasMore: !!res.result.hasMore,
        });
        this.applyFilter();
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        wx.removeStorageSync(TOKEN_KEY);
        this.setData({ isAdmin: false });
        wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '加载失败', icon: 'none' });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  loadMore() {
    if (!this.data.hasMore) return;
    this.loadBookings(true);
  },

  onFilter(e) {
    this.setData({ filterStatus: e.currentTarget.dataset.status }, () => {
      this.applyFilter();
    });
  },

  applyFilter() {
    const { bookings, filterStatus } = this.data;
    const filtered = filterStatus === 'all'
      ? bookings
      : bookings.filter(b => b.status === filterStatus);
    this.setData({ filtered });
  },

  // 查看顾客的个人信息（只读）。资料以云端为准，每次点开都重新拉
  async openUserProfile(e) {
    const openid = e.currentTarget.dataset.openid;
    if (!openid) return;
    const token = wx.getStorageSync(TOKEN_KEY);
    if (!token) {
      this.setData({ isAdmin: false });
      return;
    }
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminGetUserProfile',
        data: { token, openid },
      });
      const r = res.result;
      if (!r || !r.success) {
        if (r && r.code === 'UNAUTHORIZED') {
          wx.removeStorageSync(TOKEN_KEY);
          this.setData({ isAdmin: false });
          wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
        } else {
          wx.showToast({ title: (r && r.message) || '读取失败', icon: 'none' });
        }
        return;
      }
      const info = r.exists ? r.info : null;
      this.setData({
        showUserProfile: true,
        userInfo: info,
        userNickname: (r.profile && r.profile.nickname) || '',
        userInfoHint: r.exists
          ? '顾客自己填写，以这里显示的为准'
          : '该顾客还没有填写个人信息',
      });
    } catch (err) {
      console.error('读取顾客资料失败', err);
      wx.showToast({ title: '读取失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  closeUserProfile() {
    this.setData({ showUserProfile: false });
  },

  async doAction(e) {
    const { id, action } = e.currentTarget.dataset;
    const actionLabel = { confirm: '确认', reject: '拒绝', complete: '标记完成' }[action] || '操作';

    const r = await new Promise(resolve => {
      wx.showModal({
        title: `${actionLabel}这条预约？`,
        content: action === 'complete' ? '标记为已完成服务' : '',
        confirmColor: '#C95B7C',
        success: resolve,
        fail: resolve,
      });
    });
    if (!r || !r.confirm) return;

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminUpdateBooking',
        data: {
          bookingId: id,
          action,
          token: wx.getStorageSync(TOKEN_KEY),
        },
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message || '操作成功', icon: 'success' });
        this.loadBookings();
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        wx.removeStorageSync(TOKEN_KEY);
        this.setData({ isAdmin: false });
        wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '操作失败', icon: 'none' });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  goSlots() {
    wx.navigateTo({ url: '/pages/adminSlots/adminSlots' });
  },

  goStyles() {
    wx.navigateTo({ url: '/pages/adminStyles/adminStyles' });
  },
});