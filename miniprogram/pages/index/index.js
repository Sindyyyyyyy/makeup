// pages/index/index.js - 顾客预约主页 v1.1.0
const { SLOT_DEFS, SLOT_NAME_MAP, STATUS_TEXT, computeWeekDates } = require('../../utils/slots.js');

Page({
  data: {
    slots: SLOT_DEFS.map((s, i) => ({ ...s, _idx: i })),
    weekOffset: 0,
    weekDates: [],
    weekRange: '',
    grid: [[], [], []],
    myBookings: [],
    statusText: STATUS_TEXT,
    showModal: false,
    modalInfo: '',
    modalDate: '',
    modalSlot: '',
    form: {
      name: '',
      skinType: '',
      remark: '',
    },
    submitting: false,
  },

  onLoad() {
    this.applyWeek(0);
  },

  onShow() {
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  // ============ 日期/周 ============
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
    this.loadAll();
  },

  nextWeek() {
    this.applyWeek(this.data.weekOffset + 1);
    this.loadAll();
  },

  // ============ 加载数据 ============
  async loadAll() {
    try {
      await Promise.all([this.loadSchedule(), this.loadMyBookings()]);
    } catch (e) {
      console.error('加载失败', e);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  async loadSchedule() {
    const weekDates = this.data.weekDates;
    if (!weekDates.length) return;

    // 统一走云函数，客户端不再直连数据库
    const res = await wx.cloud.callFunction({
      name: 'listWeekSchedule',
      data: { dates: weekDates.map(d => d.date) },
    });
    if (!res.result || !res.result.success) {
      throw new Error((res.result && res.result.message) || '时段加载失败');
    }

    const tsMap = {};
    (res.result.timeSlots || []).forEach(r => { tsMap[r.date] = r; });
    const myBkMap = {};
    (res.result.myBookings || []).forEach(b => { myBkMap[`${b.date}_${b.slot}`] = b._id; });

    const grid = [[], [], []];
    for (let s = 0; s < SLOT_DEFS.length; s++) {
      const slotKey = SLOT_DEFS[s].key;
      for (let d = 0; d < weekDates.length; d++) {
        const day = weekDates[d];
        const key = `${day.date}_${slotKey}`;

        if (myBkMap[key]) {
          grid[s][d] = { status: 'mine', bookingId: myBkMap[key] };
          continue;
        }
        // 已过去的日期一律不可预约
        if (day.isPast) {
          grid[s][d] = { status: 'locked', slotState: null };
          continue;
        }

        const ts = tsMap[day.date];
        const slotState = ts ? ts[slotKey] : null;
        if (slotState && typeof slotState === 'object') {
          if (slotState.booked === true) {
            grid[s][d] = { status: 'taken', slotState };
          } else if (slotState.open !== true) {
            grid[s][d] = { status: 'locked', slotState };
          } else {
            grid[s][d] = { status: 'available', slotState };
          }
        } else {
          grid[s][d] = { status: 'locked', slotState: null };
        }
      }
    }
    this.setData({ grid });
  },

  async loadMyBookings() {
    try {
      const res = await wx.cloud.callFunction({ name: 'listMyBookings' });
      if (res.result && res.result.success) {
        const bookings = (res.result.data || []).map(b => ({
          ...b,
          slotLabel: SLOT_NAME_MAP[b.slot] || b.slot,
        }));
        this.setData({ myBookings: bookings });
      } else {
        console.error('listMyBookings failed:', res.result);
        this.setData({ myBookings: [] });
      }
    } catch (e) {
      console.error('loadMyBookings error:', e);
      this.setData({ myBookings: [] });
    }
  },

  // ============ 预约流程 ============
  onSlotTap(e) {
    const { date, slot, label, status } = e.currentTarget.dataset;
    if (status !== 'available') return;

    this.setData({
      showModal: true,
      modalDate: date,
      modalSlot: slot,
      modalInfo: `${date} ${label}`,
      form: { name: '', skinType: '', remark: '' },
    });
  },

  closeModal() {
    this.setData({ showModal: false });
  },

  noop() {},

  onNameInput(e) { this.setData({ 'form.name': e.detail.value }); },
  onSkinTypeInput(e) { this.setData({ 'form.skinType': e.detail.value }); },
  onRemarkInput(e) { this.setData({ 'form.remark': e.detail.value }); },

  async submitBooking() {
    const { form, modalDate, modalSlot } = this.data;
    if (!form.name || !form.name.trim()) {
      return wx.showToast({ title: '请输入姓名', icon: 'none' });
    }
    if (!form.skinType || !form.skinType.trim()) {
      return wx.showToast({ title: '请填写肤质', icon: 'none' });
    }

    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'createBooking',
        data: {
          date: modalDate,
          slot: modalSlot,
          name: form.name.trim(),
          skinType: form.skinType.trim(),
          remark: (form.remark || '').trim(),
        },
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: '预约成功 ✓', icon: 'success' });
        this.setData({ showModal: false });
        this.loadAll();
      } else if (res.result && res.result.code === 'NO_OPENID') {
        // 服务端拿不到身份，长文本用弹窗展示，避免 toast 截断
        wx.showModal({
          title: '无法提交预约',
          content: res.result.message,
          showCancel: false,
        });
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '提交失败', icon: 'none', duration: 2500 });
        this.loadSchedule();
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async cancelBooking(e) {
    const { id } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '确认取消？',
      content: '取消后该时段将重新开放',
      confirmColor: '#C95B7C',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await wx.cloud.callFunction({
            name: 'cancelBooking',
            data: { bookingId: id },
          });
          if (res.result && res.result.success) {
            wx.showToast({ title: '已取消', icon: 'success' });
            that.loadAll();
          } else {
            wx.showToast({ title: (res.result && res.result.message) || '操作失败', icon: 'none' });
          }
        } catch (e) {
          console.error(e);
          wx.showToast({ title: '操作失败', icon: 'none' });
        }
      },
    });
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },
});