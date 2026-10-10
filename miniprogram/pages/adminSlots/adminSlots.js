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
    // 妆造编辑弹窗
    showStyleModal: false,
    modalDate: '',
    modalSlot: '',
    modalSlotName: '',
    modalIsOpen: false,
    modalBooked: false,
    modalDone: false,
    modalStyles: [],
    quickStyles: [],
    saving: false,
  },

  onLoad() {
    this.applyWeek(0);
    if (wx.getStorageSync(TOKEN_KEY)) {
      this.setData({ isAdmin: true });
      this.loadStyleLibrary();
    }
  },

  onShow() {
    if (this.data.isAdmin) {
      this.loadSlots();
      // 从妆容管理页返回时按钮可能已增减
      this.loadStyleLibrary();
    }
  },

  // 妆造库 → 时段弹窗里的快捷按钮
  async loadStyleLibrary() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminStyles',
        data: { action: 'list', token: wx.getStorageSync(TOKEN_KEY) },
      });
      if (res.result && res.result.success) {
        this.setData({
          quickStyles: (res.result.styles || []).map(s => ({ name: s.name, price: String(s.price) })),
        });
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else if (res.result) {
        // 妆造库是可选依赖，报错只提示不阻塞时段管理
        const msg = res.result.message || '';
        if (msg.length > 18) {
          wx.showModal({ title: '妆造库提示', content: msg, showCancel: false });
        }
      }
    } catch (e) {
      console.error('loadStyleLibrary error:', e);
    }
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
          ? {
              open: !!slotState.open,
              booked: !!slotState.booked,
              done: !!slotState.done,
              styles: Array.isArray(slotState.styles) ? slotState.styles : [],
            }
          : { open: false, booked: false, done: false, styles: [] };
      }
    }
    this.setData({ grid });
  },

  // 按日期 + 时段 key 取出网格中的状态
  findCell(date, slot) {
    const sIdx = SLOT_DEFS.findIndex(s => s.key === slot);
    const dIdx = this.data.weekDates.findIndex(d => d.date === date);
    if (sIdx < 0 || dIdx < 0) return null;
    return this.data.grid[sIdx][dIdx] || null;
  },

  // ============ 妆造编辑 ============
  // 点击格子：未开放 → 填写妆造并开放；已开放 → 编辑已开放时段的妆造
  onSlotToggle(e) {
    const { date, slot, past } = e.currentTarget.dataset;
    if (past) {
      return wx.showToast({ title: '已过去的日期无需开放', icon: 'none' });
    }
    const slotDef = SLOT_DEFS.find(s => s.key === slot);
    const cell = this.findCell(date, slot);
    // 已完成的时段默认不可点击：妆造与状态都已归档，不再允许任何修改
    if (cell && cell.done) return;
    const open = !!(cell && cell.open);

    this.setData({
      showStyleModal: true,
      modalDate: date,
      modalSlot: slot,
      modalSlotName: `${date} ${slotDef ? slotDef.name + ' ' + slotDef.time : slot}`,
      modalIsOpen: open,
      modalBooked: !!(cell && cell.booked),
      modalDone: !!(cell && cell.done),
      modalStyles: (cell && cell.styles ? cell.styles : []).map(s => ({ name: s.name, price: String(s.price) })),
    });
  },

  closeStyleModal() {
    this.setData({ showStyleModal: false });
  },

  noop() {},

  addStyleRow() {
    if (this.data.modalBooked) {
      return wx.showToast({ title: '该时段已有预约，不能修改妆造', icon: 'none' });
    }
    if (this.data.modalStyles.length >= 10) {
      return wx.showToast({ title: '妆造最多添加 10 个', icon: 'none' });
    }
    this.setData({ 'modalStyles': [...this.data.modalStyles, { name: '', price: '' }] });
  },

  // 点击常用妆造：优先填入第一个空行，否则追加到末尾
  onQuickStyle(e) {
    if (this.data.modalBooked) {
      return wx.showToast({ title: '该时段已有预约，不能修改妆造', icon: 'none' });
    }
    const q = this.data.quickStyles[Number(e.currentTarget.dataset.idx)];
    if (!q) return;

    const list = this.data.modalStyles.slice();
    if (list.some(s => (s.name || '').trim() === q.name)) {
      return wx.showToast({ title: `「${q.name}」已在列表中`, icon: 'none' });
    }
    if (list.length >= 10) {
      return wx.showToast({ title: '妆造最多添加 10 个', icon: 'none' });
    }
    const emptyIdx = list.findIndex(s => !(s.name || '').trim());
    if (emptyIdx >= 0) {
      list[emptyIdx] = { name: q.name, price: q.price };
    } else {
      list.push({ name: q.name, price: q.price });
    }
    this.setData({ modalStyles: list });
  },

  removeStyleRow(e) {
    if (this.data.modalBooked) {
      return wx.showToast({ title: '该时段已有预约，不能修改妆造', icon: 'none' });
    }
    const idx = Number(e.currentTarget.dataset.idx);
    const list = this.data.modalStyles.slice();
    list.splice(idx, 1);
    this.setData({ modalStyles: list });
  },

  onStyleNameInput(e) {
    this.setData({ [`modalStyles[${e.currentTarget.dataset.idx}].name`]: e.detail.value });
  },

  onStylePriceInput(e) {
    this.setData({ [`modalStyles[${e.currentTarget.dataset.idx}].price`]: e.detail.value });
  },

  // 校验并提交：保存妆造并开放该时段（已开放的时段则只更新妆造）
  async saveStyles() {
    const { modalDate, modalSlot, modalStyles, modalIsOpen, modalBooked, saving } = this.data;
    if (saving) return;

    // 已有预约的时段妆造只读，服务端同样会拦截
    if (modalBooked) {
      return wx.showToast({ title: '该时段已有预约，不能修改妆造', icon: 'none' });
    }

    if (modalStyles.length === 0) {
      return wx.showToast({ title: '请至少添加一个妆造', icon: 'none' });
    }
    const styles = [];
    for (const s of modalStyles) {
      const name = (s.name || '').trim();
      if (!name) return wx.showToast({ title: '妆造名称不能为空', icon: 'none' });
      const price = Number(String(s.price).trim());
      if (!isFinite(price) || isNaN(price) || price < 0) {
        return wx.showToast({ title: `「${name}」的价格无效`, icon: 'none' });
      }
      styles.push({ name, price });
    }

    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminSetTimeSlot',
        data: {
          date: modalDate,
          slot: modalSlot,
          action: 'open',
          styles,
          token: wx.getStorageSync(TOKEN_KEY),
        },
      });
      if (res.result && res.result.success) {
        // 重新拉取并校验妆造是否真的落库，避免旧版云函数静默丢弃 styles
        await this.loadSlots();
        const saved = this.findCell(modalDate, modalSlot);
        if (!saved || (saved.styles || []).length !== styles.length) {
          wx.showModal({
            title: '妆造未保存',
            content: '该时段已开放，但妆造没有写入数据库。\n'
              + '通常是因为云函数 adminSetTimeSlot 仍是旧版本。\n'
              + '请在开发者工具中右键该云函数目录 → 上传并部署：云端安装依赖，然后重试。',
            showCancel: false,
          });
          return;
        }
        wx.showToast({ title: modalIsOpen ? '妆造已更新' : '已开放预约', icon: 'success' });
        this.setData({ showStyleModal: false });
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '操作失败', icon: 'none' });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // 仅关闭时段（妆造配置保留）
  async closeSlot() {
    const { modalDate, modalSlot, saving } = this.data;
    if (saving) return;
    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminSetTimeSlot',
        data: {
          date: modalDate,
          slot: modalSlot,
          action: 'close',
          token: wx.getStorageSync(TOKEN_KEY),
        },
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message, icon: 'success' });
        this.setData({ showStyleModal: false });
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
      this.setData({ saving: false });
    }
  },

  goBack() {
    wx.navigateBack();
  },
});