// pages/index/index.js - 顾客预约主页 v1.1.0
const { SLOT_DEFS, SLOT_NAME_MAP, SLOT_ORDER, STATUS_TEXT, computeWeekDates } = require('../../utils/slots.js');

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
    modalStyles: [],
    selectedStyle: -1,
    form: {
      name: '',
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
        // 越晚的越靠上：日期倒序，同一天按晚上→下午→上午排。
        // 不能靠数据库 orderBy('slot','desc')，那会按字母序排成 evening/morning/afternoon
        const bookings = (res.result.data || [])
          .slice()
          .sort((a, b) => {
            if (a.date !== b.date) return a.date < b.date ? 1 : -1;
            const ra = SLOT_ORDER[a.slot] == null ? -1 : SLOT_ORDER[a.slot];
            const rb = SLOT_ORDER[b.slot] == null ? -1 : SLOT_ORDER[b.slot];
            return rb - ra;
          })
          .map(b => ({
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
    const { date, slot, label, status, styles } = e.currentTarget.dataset;
    if (status !== 'available') return;

    const list = Array.isArray(styles) ? styles : [];
    this.setData({
      showModal: true,
      modalDate: date,
      modalSlot: slot,
      modalInfo: `${date} ${label}`,
      modalStyles: list,
      selectedStyle: list.length === 1 ? 0 : -1,
      form: { name: '' },
    });
  },

  closeModal() {
    this.setData({ showModal: false });
  },

  noop() {},

  onSelectStyle(e) {
    this.setData({ selectedStyle: Number(e.currentTarget.dataset.idx) });
  },

  onNameInput(e) { this.setData({ 'form.name': e.detail.value }); },

  async submitBooking() {
    const { form, modalDate, modalSlot, modalStyles, selectedStyle } = this.data;
    if (!form.name || !form.name.trim()) {
      return wx.showToast({ title: '请输入姓名', icon: 'none' });
    }
    if (modalStyles.length > 0 && selectedStyle < 0) {
      return wx.showToast({ title: '请选择要画的妆造', icon: 'none' });
    }
    const style = selectedStyle >= 0 ? modalStyles[selectedStyle] : null;

    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'createBooking',
        data: {
          date: modalDate,
          slot: modalSlot,
          name: form.name.trim(),
          styleName: style ? style.name : '',
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
});