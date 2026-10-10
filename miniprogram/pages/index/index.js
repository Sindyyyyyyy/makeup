// pages/index/index.js - 顾客预约主页 v1.1.0
const { SLOT_DEFS, SLOT_NAME_MAP, SLOT_ORDER, STATUS_TEXT, computeWeekDates } = require('../../utils/slots.js');
const { emptyForm, toForm, missingFields } = require('../../utils/profileInfo');

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
    // 与个人中心共用同一个昵称字段（users.nickname）
    nickname: '',
    // 预约前置的个人信息确认（infoMode: confirm=预约前确认, view=随时查看更新）
    showInfo: false,
    infoMode: '',
    info: emptyForm(),
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
  // 昵称与个人信息唯一来源是 users 文档（个人中心写入）：
  // 先读本地缓存秒开，再拉云端校准
  async loadProfile() {
    const cached = wx.getStorageSync('user_profile');
    const cachedInfo = wx.getStorageSync('user_info');
    if (cached && cached.nickname && cached.nickname !== this.data.nickname) {
      this.setData({ nickname: cached.nickname });
    }
    if (cachedInfo && typeof cachedInfo === 'object') {
      this.setData({ info: toForm(cachedInfo, this.data.nickname) });
    }
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'get' },
      });
      const r = res.result;
      if (!r || !r.success || !r.profile) return;
      const nickname = r.profile.nickname || '';
      if (nickname && nickname !== this.data.nickname) this.setData({ nickname });
      const info = toForm(r.info, nickname);
      this.setData({ info });
      wx.setStorageSync('user_profile', {
        avatarUrl: (r.profile && r.profile.avatarUrl) || (cached && cached.avatarUrl) || '',
        nickname,
      });
      wx.setStorageSync('user_info', info);
    } catch (err) {
      // 拉不到就沿用缓存，不打扰顾客
      console.warn('获取个人资料失败', err);
    }
  },

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
    });
    this.loadProfile();
  },

  closeModal() {
    this.setData({ showModal: false });
  },

  noop() {},

  onSelectStyle(e) {
    this.setData({ selectedStyle: Number(e.currentTarget.dataset.idx) });
  },

  // 第一步：不是直接下单，而是先弹个人信息表让顾客确认/补全
  async submitBooking() {
    const { nickname, modalDate, modalSlot, modalStyles, selectedStyle } = this.data;
    if (!(nickname || '').trim()) {
      return wx.showToast({ title: '请先到个人中心设置昵称', icon: 'none' });
    }
    if (modalStyles.length > 0 && selectedStyle < 0) {
      return wx.showToast({ title: '请选择要画的妆造', icon: 'none' });
    }

    await this.loadProfile();
    const missing = missingFields(this.data.info, { requirePhoto: true });
    if (missing.length) {
      wx.showToast({ title: `还差：${missing.slice(0, 2).join('、')}`, icon: 'none' });
    }
    this.setData({ showInfo: true, infoMode: 'confirm' });
  },

  // 预约卡片上的“详细信息”：随时查看/更新最新个人信息，不涉及下单
  async openInfoDetail() {
    await this.loadProfile();
    this.setData({ showInfo: true, infoMode: 'view' });
  },

  closeInfo() {
    this.setData({ showInfo: false });
  },

  // 第二步：个人信息确认（并补全）通过后才真正下单
  async onSaveInfo(e) {
    const form = e.detail.info || {};
    this.setData({ submitting: true });
    const formCmp = this.selectComponent('#infoForm');
    if (formCmp) formCmp.setSubmitting(true);
    try {
      const saveRes = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'saveInfo', nickname: this.data.nickname, info: form },
      });
      if (!saveRes.result || !saveRes.result.success) {
        console.error('保存个人信息失败：', saveRes.result);
        wx.showToast({ title: (saveRes.result && saveRes.result.message) || '保存失败', icon: 'none' });
        return;
      }
      const info = toForm(saveRes.result.info, this.data.nickname);
      this.setData({ info });
      wx.setStorageSync('user_info', info);
      this.setData({ showInfo: false });
      // 预约前确认才接着下单；单看详情只保存
      if (this.data.infoMode === 'confirm') {
        await this.doCreateBooking();
      } else {
        wx.showToast({ title: '已更新', icon: 'success' });
      }
    } catch (err) {
      console.error('保存个人信息异常：', err);
      wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' });
    } finally {
      if (formCmp) formCmp.setSubmitting(false);
      this.setData({ submitting: false });
    }
  },

  async doCreateBooking() {
    const { nickname, modalDate, modalSlot, modalStyles, selectedStyle } = this.data;
    const style = selectedStyle >= 0 ? modalStyles[selectedStyle] : null;

    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'createBooking',
        data: {
          date: modalDate,
          slot: modalSlot,
          name: (nickname || '').trim(),
          styleName: style ? style.name : '',
        },
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: '预约成功', icon: 'success' });
        this.setData({ showModal: false });
        this.loadAll();
      } else if (res.result && res.result.code === 'NO_OPENID') {
        // 服务端拿不到身份，长文本用弹窗展示，避免 toast 截断
        wx.showModal({
          title: '无法提交预约',
          content: res.result.message,
          showCancel: false,
        });
      } else if (res.result && res.result.code === 'PROFILE_INCOMPLETE') {
        // 服务端判定资料不完整（可能资料刚被改过、或前后端规则不同步）：
        // 重新拉一次云端，以云端为准把缺项回显在表里让用户当场补
        await this.loadProfile();
        this.setData({ showInfo: true });
        wx.showToast({ title: '请先补全个人信息', icon: 'none' });
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