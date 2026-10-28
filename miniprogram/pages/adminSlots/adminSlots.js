// pages/adminSlots/adminSlots.js - 时间管理页
//
// 这里改的是**每天三个时段的起止时间**（全局默认，对所有日期生效）。
// 某一天特殊的话，在后台首页的课程表里点那个格子 →「改这天」单独调（组件
// components/scheduleGrid 负责那部分）。
//
// 时间是数据不是代码：权威值在 timeSlots 集合的 _id='slot_times' 那篇配置文档里，
// 本页通过 adminSlotTimes 云函数读写它。
const { isLoggedIn, clearAdmin } = require('../../utils/role.js');
const { SLOT_DEFS, normalizeSlotTimes, normHM } = require('../../utils/slots.js');

const TOKEN_KEY = 'admin_token';

Page({
  data: {
    isAdmin: false,
    loading: true,
    saving: false,
    // 三行时段（{key,name,start,end}）。WXML 不能调用 JS 函数，整行都要进 data。
    rows: [],
    // 恢复默认时的目标值（兜底默认，服务端也会原样返回一份）
    defaults: [],
    // 已经被单独调整过的日期数量
    overrideCount: 0,
  },

  onLoad() {
    this.setData({ isAdmin: isLoggedIn() });
  },

  onShow() {
    if (!this.data.isAdmin) return;
    this.loadTimes();
  },

  onPullDownRefresh() {
    if (!this.data.isAdmin) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadTimes().then(() => wx.stopPullDownRefresh());
  },

  // 读当前配置（一次云调用）。配置文档还不存在时服务端回默认值。
  async loadTimes() {
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminSlotTimes',
        data: { action: 'get', token: wx.getStorageSync(TOKEN_KEY) },
      });
      const r = res.result;
      if (!r || !r.success) {
        if (r && r.code === 'UNAUTHORIZED') {
          this.handleAuthFail();
        } else {
          wx.showToast({ title: (r && r.message) || '加载失败', icon: 'none' });
        }
        return;
      }
      const times = normalizeSlotTimes(r.slotTimes);
      const defaults = normalizeSlotTimes(r.defaults);
      this.setData({
        rows: this.buildRows(times),
        defaults: this.buildRows(defaults),
        overrideCount: Object.keys(times.overrides || {}).length,
      });
    } catch (e) {
      console.error('读取时段时间失败', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 把 {morning:{start,end},...} 摊成三行，模板里直接循环
  buildRows(times) {
    return SLOT_DEFS.map(s => ({
      key: s.key,
      name: s.name,
      start: times[s.key].start,
      end: times[s.key].end,
    }));
  },

  // 找到某一行的当前值（rows 是唯一来源，改动都落到 rows 上）
  rowOf(key) {
    return this.data.rows.find(r => r.key === key) || null;
  },

  onStartChange(e) {
    const { slot } = e.currentTarget.dataset;
    const v = normHM(e.detail.value);
    this.setData({ rows: this.data.rows.map(r => (r.key === slot ? { ...r, start: v } : r)) });
  },

  onEndChange(e) {
    const { slot } = e.currentTarget.dataset;
    const v = normHM(e.detail.value);
    this.setData({ rows: this.data.rows.map(r => (r.key === slot ? { ...r, end: v } : r)) });
  },

  // 保存：服务端会校验（起止合法、三段不重叠），报错用弹窗展示完整文字
  async save() {
    if (this.data.saving) return;
    const times = {};
    this.data.rows.forEach(r => { times[r.key] = { start: r.start, end: r.end }; });
    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminSlotTimes',
        data: { action: 'set', times, token: wx.getStorageSync(TOKEN_KEY) },
      });
      const r = res.result;
      if (r && r.success) {
        const next = normalizeSlotTimes(r.slotTimes);
        this.setData({
          rows: this.buildRows(next),
          overrideCount: Object.keys(next.overrides || {}).length,
        });
        const synced = r.synced ? `，${r.synced}个预约已同步` : '';
        wx.showToast({ title: `时间已保存${synced}`, icon: 'none', duration: 2500 });
      } else if (r && r.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        wx.showModal({
          title: '保存失败',
          content: (r && r.message) || '操作失败',
          showCancel: false,
        });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // 恢复默认时间（立即生效，保存前先问一句）
  restoreDefault() {
    const defaults = this.data.defaults;
    if (!defaults.length) return;
    wx.showModal({
      title: '恢复默认时间',
      content: `将恢复为\n${defaults.map(d => `${d.name} ${d.start}-${d.end}`).join('\n')}\n\n未完成的预约会同步到新的时间，确定吗？`,
      confirmColor: '#C95B7C',
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ saving: true });
        try {
          const times = {};
          defaults.forEach(d => { times[d.key] = { start: d.start, end: d.end }; });
          const res = await wx.cloud.callFunction({
            name: 'adminSlotTimes',
            data: { action: 'set', times, token: wx.getStorageSync(TOKEN_KEY) },
          });
          const res2 = res.result;
          if (res2 && res2.success) {
            const next = normalizeSlotTimes(res2.slotTimes);
            this.setData({
              rows: this.buildRows(next),
              overrideCount: Object.keys(next.overrides || {}).length,
            });
            wx.showToast({ title: '已恢复默认时间', icon: 'success' });
          } else if (res2 && res2.code === 'UNAUTHORIZED') {
            this.handleAuthFail();
          } else {
            wx.showModal({
              title: '恢复失败',
              content: (res2 && res2.message) || '操作失败',
              showCancel: false,
            });
          }
        } catch (e) {
          console.error(e);
          wx.showToast({ title: '操作失败', icon: 'none' });
        } finally {
          this.setData({ saving: false });
        }
      },
    });
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
