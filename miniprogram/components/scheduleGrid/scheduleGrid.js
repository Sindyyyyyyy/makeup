// components/scheduleGrid/scheduleGrid.js - 课程表（唯一副本）
// 化妆师后台首页 components/adminPanel 与「时间管理」页之前的时段管理页共用这一份，
// 两边的开关时段 / 设妆造 / 看顾客详情行为因此天然一致。
// 方法必须放在 methods 下：Component 会静默丢弃顶层方法。
const {
  SLOT_DEFS, computeWeekDates, isSlotExpired,
  buildSlotRows, normalizeSlotTimes, resolveSlotTime, isCustomTime, formatRange, normHM,
} = require('../../utils/slots.js');
const { isLoggedIn } = require('../../utils/role.js');
const styleCache = require('../../utils/styleCache.js');

const TOKEN_KEY = 'admin_token';

// 「操作说明」的正文。整段存成一个用 \n 连起来的字符串，而不是逐条 <view>：
// <text> 组件会把 \n 渲染成换行，这样 -webkit-line-clamp 才能精确地按「行」
// 截断（拆成多个子节点时它们会变成 flex item，截断粒度会变成「条」而不是「行」）。
const TIPS_TEXT = [
  '· 点击格子可开放/关闭该时段，并添加该时段可画的妆造与价格',
  '· 开放后顾客即可预约该时段，并在下单时选择妆造',
  '· 已有预约的时段无法关闭，请先在预约列表中处理',
  '· 已完成的时段默认不可点击，妆造与状态均已锁定',
  '· 今天以前的时段除「已完成」外一律显示「时段已过」，不再接受修改',
  '· 当天已过结束时刻且无人预约的时段（如 11 点后的上午）也显示「时段已过」；已预约/已完成的仍保留原状态，方便查看和处理',
  '· 格子右上角的 ⏱ 表示这一天的这个时段被单独改过时间，点开弹窗点「改这天」可以调；每天的默认起止时间在「时间管理」里改',
].join('\n');

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
//
// tm 是这一格的**有效时间段**（单日覆盖优先，来自时段时间配置）：
//   { range:'09:30-11:30', start:'09:30', end:'11:30', custom:false }
// custom 为真表示这一天的这个时段被单独改过时间，界面上标一个小钟。
function toCell(slotState, pastDate, expiredSlot, tm) {
  const s = (slotState && typeof slotState === 'object') ? slotState : null;
  const open = !!(s && s.open);
  const booked = !!(s && s.booked);
  const done = !!(s && s.done);
  const t = tm || { range: '', start: '', end: '', custom: false };
  return {
    open,
    booked,
    done,
    styles: s && Array.isArray(s.styles) ? s.styles : [],
    past: done ? false : (!!pastDate || (!!expiredSlot && !booked)),
    // 只表示「就是今天且这个时段的结束时刻已过」，整个日期过去的格子不算，
    // 用来区分点击时给哪句提示
    expired: !!expiredSlot && !pastDate,
    time: t.range,
    tStart: t.start,
    tEnd: t.end,
    custom: !!t.custom,
  };
}

Component({
  properties: {
    // 是否显示底部「操作说明」（后台首页为 false，时间管理页为 true）
    showTips: { type: Boolean, value: false },
    // 为 false 时不拉数据。挂载在已登录分支里就够用，保留以备宿主要做懒加载
    active: { type: Boolean, value: true },
  },

  data: {
    weekOffset: 0,
    weekDates: [],
    weekRange: '',
    slots: buildSlotRows(null),
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
    // 弹窗里「改这一天的时间」的那一小块
    showTimeEdit: false,
    modalTimeRange: '',
    timeStart: '',
    timeEnd: '',
    timeCustom: false,
    // 只读顾客信息弹窗
    showUserProfile: false,
    userInfo: null,
    userNickname: '',
    userInfoHint: '',
    // 「想画的妆容照片」的 https 临时链接（存在这一单上，不在顾客资料上）
    userStyleRefUrls: [],
    // 底部「操作说明」默认收起（只露两行），点标题右边的三角展开/收起
    tipsExpanded: false,
    tipsText: TIPS_TEXT,
  },

  lifetimes: {
    attached() {
      this.applyWeek(0);
      // 时段时间配置：全局三段 + 单日覆盖。服务端随 adminListSlots 一起带回来，
      // 不为了取时间再多打一次云函数调用。
      this._times = normalizeSlotTimes(null);
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
    // 后台首页的 handleAuthFail() 会先静默重签、失败才清身份；别的页面则直接
    // 切到未登录提示。组件自己 wx.removeStorageSync 会把重签这条路掐断。
    handleAuthFail() {
      wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
      this.triggerEvent('authfail');
    },

    // 某一格的有效时间段（单日覆盖优先）+ 是否被单独改过
    cellTime(date, slot) {
      const times = this._times || normalizeSlotTimes(null);
      const eff = resolveSlotTime(times, date, slot);
      return {
        range: formatRange(eff),
        start: eff.start,
        end: eff.end,
        custom: isCustomTime(times, date, slot),
      };
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
          // 时段时间配置（全局三段 + 单日覆盖）跟着这次调用一起回来
          this._times = normalizeSlotTimes(res.result.slotTimes);
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
          const tm = this.cellTime(dates[d].date, slotKey);
          grid[s][d] = toCell(
            ts ? ts[slotKey] : null,
            dates[d].isPast,
            isSlotExpired(dates[d].date, tm.end),
            tm,
          );
        }
      }
      // 行标题上的时间用全局配置
      this.setData({ grid, slots: buildSlotRows(this._times) });
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
      const tm = this.cellTime(date, slot);
      const expired = isSlotExpired(info.date, tm.end);
      const grid = this.data.grid.map((row, i) => (
        i === sIdx ? row.map((c, j) => (j === dIdx ? toCell(slotState, isPast, expired, tm) : c)) : row
      ));
      this.setData({ grid });
    },

    // 只改这一格的时间，其他状态（开放/预约/妆造）原样保留。
    // 改完时间后 past / expired 可能变化（结束时刻变了），所以整格重算。
    patchCellTime(date, slot, tm) {
      const sIdx = SLOT_DEFS.findIndex(s => s.key === slot);
      const dIdx = this.data.weekDates.findIndex(d => d.date === date);
      if (sIdx < 0 || dIdx < 0) return;
      const info = this.data.weekDates[dIdx];
      const cur = this.data.grid[sIdx][dIdx] || {};
      const expired = isSlotExpired(info.date, tm.end);
      const cell = toCell(
        { open: cur.open, booked: cur.booked, done: cur.done, styles: cur.styles },
        !!info.isPast,
        expired,
        tm,
      );
      const grid = this.data.grid.map((row, i) => (
        i === sIdx ? row.map((c, j) => (j === dIdx ? cell : c)) : row
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

    // ============ 操作说明（可折叠）============
    // 点标题行右边的三角展开/收起。纯本地状态，不发任何云函数调用。
    toggleTips() {
      this.setData({ tipsExpanded: !this.data.tipsExpanded });
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
        // 弹窗标题带上这一格的**有效时间段**，改过的那天一眼能看出来
        modalSlotName: `${date} ${slotDef ? slotDef.name : slot} ${cell ? cell.time : ''}`.trim(),
        modalIsOpen: open,
        modalBooked: !!(cell && cell.booked),
        modalDone: !!(cell && cell.done),
        modalStyles: (cell && cell.styles ? cell.styles : []).map(s => ({ name: s.name, price: String(s.price) })),
        // 时间编辑区默认收起，不干扰她开妆造
        showTimeEdit: false,
        modalTimeRange: (cell && cell.time) || '',
        timeStart: (cell && cell.tStart) || '',
        timeEnd: (cell && cell.tEnd) || '',
        timeCustom: !!(cell && cell.custom),
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
          // 参考图的 https 临时链接（空数组 = 顾客这次没传）
          userStyleRefUrls: r.styleRefUrls || [],
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
      // 参考图也一起清掉：不然下次打开别人的资料时会残留上一次的图
      this.setData({ showUserProfile: false, userStyleRefUrls: [] });
    },

    closeStyleModal() {
      this.setData({ showStyleModal: false, showUserProfile: false, showTimeEdit: false, userStyleRefUrls: [] });
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

    // ============ 改这一天的时段时间 ============
    // 「改这天」：就地展开两个时间选择器（不做第二层弹窗，避免 z-index 打架）。
    // 改的是**这一天**的时间，不影响别的日期；全局默认在「时间管理」页改。
    toggleTimeEdit() {
      if (this.data.showTimeEdit) {
        this.setData({ showTimeEdit: false });
        return;
      }
      const { modalDate, modalSlot } = this.data;
      const cell = this.findCell(modalDate, modalSlot);
      this.setData({
        showTimeEdit: true,
        timeStart: (cell && cell.tStart) || '',
        timeEnd: (cell && cell.tEnd) || '',
      });
    },

    onTimeStartChange(e) {
      this.setData({ timeStart: normHM(e.detail.value) });
    },

    onTimeEndChange(e) {
      this.setData({ timeEnd: normHM(e.detail.value) });
    },

    // 保存这一天的时段时间
    async saveCellTime() {
      const { modalDate, modalSlot, timeStart, timeEnd, saving } = this.data;
      if (saving) return;
      if (!timeStart || !timeEnd) {
        return wx.showToast({ title: '请选择完整的起止时间', icon: 'none' });
      }
      this.setData({ saving: true });
      try {
        const res = await wx.cloud.callFunction({
          name: 'adminSlotTimes',
          data: {
            action: 'setDate',
            date: modalDate,
            slot: modalSlot,
            time: { start: timeStart, end: timeEnd },
            token: wx.getStorageSync(TOKEN_KEY),
          },
        });
        const r = res.result;
        if (r && r.success) {
          // 服务端回传整份配置，客户端更新本地副本后只重算这一格
          this._times = normalizeSlotTimes(r.slotTimes);
          const tm = this.cellTime(modalDate, modalSlot);
          this.patchCellTime(modalDate, modalSlot, tm);
          this.setData({
            modalTimeRange: tm.range,
            timeStart: tm.start,
            timeEnd: tm.end,
            timeCustom: tm.custom,
            showTimeEdit: false,
            // 行标题上的时间是全局值，这里不变；但整行标题要跟着新配置重建
            slots: buildSlotRows(this._times),
          });
          // toast 只有一行，超过十几个字会被截断，同步条数带上就够
          wx.showToast({
            title: r.synced ? `已保存，${r.synced}个预约已同步` : '已保存这一天的时间',
            icon: 'none',
          });
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

    // 恢复默认：删掉这一天的单日覆盖，回到全局时间
    async clearCellTime() {
      const { modalDate, modalSlot, saving } = this.data;
      if (saving) return;
      this.setData({ saving: true });
      try {
        const res = await wx.cloud.callFunction({
          name: 'adminSlotTimes',
          data: {
            action: 'clearDate',
            date: modalDate,
            slot: modalSlot,
            token: wx.getStorageSync(TOKEN_KEY),
          },
        });
        const r = res.result;
        if (r && r.success) {
          this._times = normalizeSlotTimes(r.slotTimes);
          const tm = this.cellTime(modalDate, modalSlot);
          this.patchCellTime(modalDate, modalSlot, tm);
          this.setData({
            modalTimeRange: tm.range,
            timeStart: tm.start,
            timeEnd: tm.end,
            timeCustom: tm.custom,
            showTimeEdit: false,
            slots: buildSlotRows(this._times),
          });
          wx.showToast({ title: '已恢复默认时间', icon: 'none' });
        } else if (r && r.code === 'UNAUTHORIZED') {
          this.handleAuthFail();
        } else {
          wx.showModal({
            title: '操作失败',
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
  },
});
