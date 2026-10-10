// pages/adminSlots/adminSlots.js - 时段管理 v1.1.0
const { SLOT_DEFS, computeWeekDates } = require('../../utils/slots.js');

const TOKEN_KEY = 'admin_token';

Page({
  data: {
    isAdmin: false,
    weekOffset: 0,
    weekDates: [],
    weekRange: '',
    slots: SLOT_DEFS.map((s, i) => ({ ...s, _idx: i })),
    grid: [[], [], []],
    loading: false,
    toggling: {},
  },

  onLoad() {
    this.applyWeek(0);
    if (wx.getStorageSync(TOKEN_KEY)) {
      this.setData({ isAdmin: true });
    }
  },

  onShow() {
    if (this.data.isAdmin) this.loadSlots();
  },

  onPullDownRefresh() {
    if (this.data.isAdmin) {
      this.loadSlots().then(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  applyWeek(offset) {
    const weekDates = computeWeekDates(offset);
    this.setData({
      weekOffset: offset,
      weekDates,
      weekRange: `${weekDates[0].dateLabel} - ${weekDates[6].dateLabel}`,
    });
  },

  prevWeek() {
    this.applyWeek(this.data.weekOffset - 1);
    this.loadSlots();
  },

  nextWeek() {
    this.applyWeek(this.data.weekOffset + 1);
    this.loadSlots();
  },

  handleAuthFail() {
    wx.removeStorageSync(TOKEN_KEY);
    this.setData({ isAdmin: false });
    wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
  },

  async loadSlots() {
    const weekDates = this.data.weekDates;
    if (!weekDates.length || !this.data.isAdmin) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminListSlots',
        data: {
          token: wx.getStorageSync(TOKEN_KEY),
          startDate: weekDates[0].date,
          endDate: weekDates[6].date,
        },
      });
      if (res.result && res.result.success) {
        const tsMap = {};
        res.result.slots.forEach(s => { tsMap[s.date] = s; });
        this.buildGrid(tsMap);
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '加载失败', icon: 'none' });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  buildGrid(tsMap) {
    const dates = this.data.weekDates.map(d => d.date);
    const grid = [[], [], []];
    for (let s = 0; s < SLOT_DEFS.length; s++) {
      const slotKey = SLOT_DEFS[s].key;
      for (let d = 0; d < dates.length; d++) {
        const ts = tsMap[dates[d]];
        const slotState = ts ? ts[slotKey] : null;
        grid[s][d] = slotState && typeof slotState === 'object'
          ? { open: !!slotState.open, booked: !!slotState.booked }
          : { open: false, booked: false };
      }
    }
    this.setData({ grid });
  },

  async onSlotToggle(e) {
    const { date, slot, open, past } = e.currentTarget.dataset;
    if (past) {
      return wx.showToast({ title: '已过去的日期无需开放', icon: 'none' });
    }
    const key = `${date}_${slot}`;
    if (this.data.toggling[key]) return;

    this.setData({ [`toggling.${key}`]: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminSetTimeSlot',
        data: {
          date,
          slot,
          action: open ? 'close' : 'open',
          token: wx.getStorageSync(TOKEN_KEY),
        },
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message, icon: 'success' });
        this.loadSlots();
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '操作失败', icon: 'none' });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ [`toggling.${key}`]: false });
    }
  },

  goBack() {
    wx.navigateBack();
  },
});