// components/scheduleGrid/scheduleGrid.js - 课程表（唯一副本）
// 时段管理页 pages/adminSlots 与化妆师后台首页 components/adminPanel 共用这一份，
// 两边的开关时段 / 设妆造 / 看顾客详情行为因此天然一致。
// 方法必须放在 methods 下：Component 会静默丢弃顶层方法。
const { SLOT_DEFS, computeWeekDates, isSlotExpired } = require('../../utils/slots.js');
const { isLoggedIn } = require('../../utils/role.js');
const styleCache = require('../../utils/styleCache.js');

const TOKEN_KEY = 'admin_token';

// 网格单元格的统一形状。buildGrid（整周拉取）和 patchCell（改完一处就地打补丁）
// 共用这个函数，两条路径产出的结构必须完全一致，否则打补丁的格子会和别的格子
// 在视图层长得不一样。
//
// past 是「这一格不该再改了」，跟 open/booked/done 无关，显示成「时段已过」并置灰
// （和顾客端首页一致）。两种来源：
//   1. pastDate —— 整个日期已经过去了。除「已完成」外一律算。
//   2. expiredSlot —— 就是今天，且这个时段的结束时刻已过（如上午 11 点后再看
//      09:30-11:30）。没有预约的格子这时也翻篇了；已有预约或已完成的要留着，
//      她还得靠这一格看到「这天有人来过」并去处理。
//
// 时段过了之后服务端还有定时结算（cloudfunctions/sweepOverdue）：
// pending → rejected（booked 置回 false）、confirmed → completed（done 置 true），
// 所以规则 1 落到的几乎总是这两种已结算状态，不必靠格子自己去猜。
function toCell(slotState, pastDate, expiredSlot) {
  const s = (slotState && typeof slotState === 'object') ? slotState : null;
  const open = !!(s && s.open);
  const booked = !!(s && s.booked);
  const done = !!(s && s.done);
  return {
    open,
    booked,
    done,
    styles: s && Array.isArray(s.styles) ? s.styles : [],
    past: done ? false : (!!pastDate || (!!expiredSlot && !booked)),
    // 只表示「就是今天且这个时段的结束时刻已过」，整个日期过去的格子不算，
    // 用来区分点击时给哪句提示
    expired: !!expiredSlot && !pastDate,
  };
}

Component({
  properties: {
    // 是否显示底部「操作说明」（后台首页为 false，时段管理页为 true）
    showTips: { type: Boolean, value: false },
    // 为 false 时不拉数据。挂载在已登录分支里就够用，保留以备宿主要做懒加载
    active: { type: Boolean, value: true },
  },

  data: {
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
    // 只读顾客信息弹窗
    showUserProfile: false,
    userInfo: null,
    userNickname: '',
    userInfoHint: '',
  },

  lifetimes: {
    attached() {
      this.applyWeek(0);
      if (this.data.active && isLoggedIn()) {
        this.loadSlots();
        // 妆造库不进弹窗就没用，但快捷按钮是弹窗里最常点的东西，先拉好省得她等
        this.loadStyleLibrary();
      }
    },
  },

  methods: {
    // 宿主调用：重新拉时段表。妆造库走 styleCache 的 5 分钟共享缓存——
    // 妆容管理页每次增删都会把新列表写回缓存（连时间戳一起刷新），所以
    // 「刚改完妆造就返回时段管理」拿到的必然是最新的一份，不必每次都绕过缓存。
    // 妆造库真过期时 getStyles 会自己去云端取，这里不用管。
    // 返回 Promise，宿主可 await。
    reload() {
      if (!this.data.active || !isLoggedIn()) return Promise.resolve();
      return this.loadSlots();
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

    // 令牌失效：**不动登录状态**，只提示并把决定权交给宿主。
    // 后台首页的 handleAuthFail() 会先静默重签、失败才清身份；时段管理页则直接
    // 切到未登录提示。组件自己 wx.removeStorageSync 会把重签这条路掐断。
    handleAuthFail() {
      wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
      this.triggerEvent('authfail');
    },

    async loadSlots() {
      const weekDates = this.data.weekDates;
      if (!weekDates.length || !isLoggedIn()) return;
      this.setData({ loading: true });
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
      } finally {
        this.setData({ loading: false });
      }
    },

    buildGrid(tsMap) {
      const dates = this.data.weekDates;
      const grid = [[], [], []];
      for (let s = 0; s < SLOT_DEFS.length; s++) {
        const slotKey = SLOT_DEFS[s].key;
        for (let d = 0; d < dates.length; d++) {
          const ts = tsMap[dates[d].date];
          grid[s][d] = toCell(
            ts ? ts[slotKey] : null,
            dates[d].isPast,
            isSlotExpired(dates[d].date, slotKey),
          );
        }
      }
      this.setData({ grid });
    },

    // 就地更新一个格子。adminSetTimeSlot 会在响应里回传它刚写进去的那个时段，
    // 所以「保存妆造」「关闭时段」不必再把整周时段表重拉一遍——原来每次保存都要
    // 多花一次云函数调用外加 7 天 × 3 个时段的响应体积。
    // 下拉刷新 / 翻周仍然全量重拉，所以数据不会因为打补丁而长期偏离服务端。
    patchCell(date, slot, slotState) {
      const sIdx = SLOT_DEFS.findIndex(s => s.key === slot);
      const dIdx = this.data.weekDates.findIndex(d => d.date === date);
      if (sIdx < 0 || dIdx < 0) return;
      const info = this.data.weekDates[dIdx];
      const isPast = !!info.isPast;
      const expired = isSlotExpired(info.date, slot);
      const grid = this.data.grid.map((row, i) => (
        i === sIdx ? row.map((c, j) => (j === dIdx ? toCell(slotState, isPast, expired) : c)) : row
      ));
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
      const { date, slot, past, expired } = e.currentTarget.dataset;
      if (past) {
        // 已过去的日期 vs 就是今天但这个时段已经过了——两种都说得通，给不同的提示
        const title = expired ? '该时段今天已经过了' : '已过去的日期无需开放';
        return wx.showToast({ title, icon: 'none' });
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
      // 这里刻意不调任何云函数：打开弹窗只是一次本地渲染，
      // 顾客资料等她真的点「详细信息」再查（云函数调用次数是稀缺的）
    },

    // 「详细信息」：一次调用拿到「预约 + 顾客资料」。
    // 顾客 openid 只存在 bookings 里，客户端拿不到，所以由 adminGetUserProfile
    // 传 date+slot 让服务端自己去解析——比「先查 bookings 再查 users」少一次调用。
    async openFirstBookingDetail() {
      const { modalDate, modalSlot } = this.data;
      wx.showLoading({ title: '加载中', mask: true });
      try {
        const res = await wx.cloud.callFunction({
          name: 'adminGetUserProfile',
          data: { token: wx.getStorageSync(TOKEN_KEY), date: modalDate, slot: modalSlot },
        });
        const r = res.result;
        if (!r || !r.success) {
          if (r && r.code === 'UNAUTHORIZED') {
            this.handleAuthFail();
          } else {
            wx.showToast({ title: (r && r.message) || '读取失败', icon: 'none' });
          }
          return;
        }
        // 没有对应预约记录（历史脏数据：时段被占了但 bookings 里查无此单）
        if (!r.booking) {
          return wx.showToast({ title: '未找到该时段的预约记录', icon: 'none' });
        }
        this.setData({
          showUserProfile: true,
          userInfo: r.exists ? r.info : null,
          userNickname: (r.profile && r.profile.nickname) || '',
          userInfoHint: r.exists ? '顾客自己填写，以这里显示的为准' : '该顾客还没有填写个人信息',
        });
      } catch (e) {
        console.error('读取顾客资料失败', e);
        wx.showToast({ title: '读取失败', icon: 'none' });
      } finally {
        wx.hideLoading();
      }
    },

    closeUserProfile() {
      this.setData({ showUserProfile: false });
    },

    closeStyleModal() {
      this.setData({ showStyleModal: false, showUserProfile: false });
    },

    noop() {},

    // 妆造库 → 时段弹窗里的快捷按钮
    // 走 styleCache 的共享缓存：妆容管理页也在维护同一份库，原来两边各拉一次。
    // 缓存只存「妆造有哪些」，不存令牌，也不绕过服务端的 UNAUTHORIZED。
    async loadStyleLibrary() {
      try {
        const r = await styleCache.getStyles();
        if (r && r.success) {
          this.setData({
            quickStyles: (r.styles || []).map(s => ({ name: s.name, price: String(s.price) })),
          });
        } else if (r && r.code === 'UNAUTHORIZED') {
          this.handleAuthFail();
        } else if (r) {
          // 妆造库是可选依赖，报错只提示不阻塞时段管理
          const msg = r.message || '';
          if (msg.length > 18) {
            wx.showModal({ title: '妆造库提示', content: msg, showCancel: false });
          }
        }
      } catch (e) {
        console.error('loadStyleLibrary error:', e);
      }
    },

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
          // 云函数会把刚写进去的那个时段原样回传（slotState）。有它就说明部署的
          // 是新版函数、确实认得 styles 字段；没有它就是还在跑旧版——旧版会静默
          // 丢掉 styles，顾客看到的时段是个没有妆造的空壳。
          // 这个判断比原来的「保存完再整周重拉一遍比对长度」更强：旧版函数无论如何
          // 都不会回传 slotState，而且省掉了那一次云函数调用。
          const st = res.result.slotState;
          if (!st) {
            wx.showModal({
              title: '妆造未保存',
              content: '该时段已开放，但云函数没有回传保存结果，说明部署的仍是旧版本。\n'
                + '请在开发者工具中右键 adminSetTimeSlot 目录 → 上传并部署：云端安装依赖，然后重试。',
              showCancel: false,
            });
            return;
          }
          this.patchCell(modalDate, modalSlot, st);
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
          // 与 saveStyles 同理：关一个格子不必重拉整周
          if (res.result.slotState) {
            this.patchCell(modalDate, modalSlot, res.result.slotState);
          } else {
            this.loadSlots();
          }
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
  },
});
