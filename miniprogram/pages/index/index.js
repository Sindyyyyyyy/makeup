// pages/index/index.js - 首页 v2.0.0
// 按身份渲染两套完全不同的界面：顾客看预约课表，化妆师看管理后台。
// 视图模式由 utils/role.js 的 currentMode() 判定（admin_token 与 admin_mode 分离）。
const {
  SLOT_DEFS, SLOT_NAME_MAP, SLOT_ORDER, computeWeekDates, isSlotExpired,
  buildSlotRows, normalizeSlotTimes, resolveSlotTime, isCustomTime, formatRange,
} = require('../../utils/slots.js');
const { emptyForm, toForm, missingFields, sameForm, sameList, fetchedAt, markFetched, clearFetched } = require('../../utils/profileInfo');
const { currentMode, syncTabBar, setMode } = require('../../utils/role.js');
const { TPL_CUSTOMER_RESULT, TPL_CUSTOMER_REVIEW, requestSubscribe } = require('../../utils/notify.js');
const { getLang, getDict, t, listJoin } = require('../../utils/i18n.js');

// 节流窗口：60 秒内不重复拉取同一批数据（云开发免费版每月仅 20 万次调用额度）
const LOAD_TTL = 60 * 1000;

// 「化妆注意事项」临时链接的本地缓存。
// getNoticeImage 不查数据库，只把一个固定的云存储 fileID 换成 https 临时链接，
// 而链接约 2 小时后才过期——每次预约都换一次是纯浪费的云函数调用。
// TTL 取 1.5 小时留出余量，避免卡在过期边界上给顾客一张打不开的图。
// 缓存按语言分桶：中英文是两张不同的图，混用会拿到另一种语言的图。
const NOTICE_CACHE_KEY = 'notice_img_cache';
const NOTICE_TTL = 90 * 60 * 1000;

Page({
  data: {
    // true=化妆师后台，false=顾客预约。决定整页渲染哪一套界面
    adminMode: false,
    // 三行时段标题（含时间）。时间是数据不是代码，loadSchedule 拿到配置后重建
    slots: buildSlotRows(null),
    weekOffset: 0,
    weekDates: [],
    weekRange: '',
    grid: [[], [], []],
    myBookings: [],
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
    // 弹窗的副标题（提示语）。view 模式要写清「改的是哪一单」——
    // 「想画的妆容照片」属于预约而不是个人资料，不说清楚她会以为改的是通用资料。
    infoHint: '',
    // 「详细信息」模式下正在改的那一单：_id 用来回写，参考图用来当编辑起点
    detailBookingId: '',
    detailStyleRefs: [],
    submitting: false,
    // 预约成功后的「注意事项」图。
    // noticeImg 只装**当前有效**的 https 临时链接：空串 = 还没有；
    // loading = 正在换一个；error = 换失败（弹窗里有重试按钮 + 包内备用图）。
    // 注意：这里绝不留着旧链接 —— 临时链接约 2 小时过期，页面实例在后台活过
    // 2 小时再打开，拿旧链接渲染出来就是一张白图（线上踩过）。
    showNotice: false,
    // 弹窗是不是「刚下单成功」那一次弹的：
    //   true  → 标题「预约成功」（刚下完单）
    //   false → 标题「化妆注意事项」（从预约卡片上重新打开的）
    noticeSuccess: false,
    noticeImg: '',
    noticeLoading: false,
    noticeError: false,
    // 界面语言。'zh' | 'en'，以及整份文案字典 L（模板里写 {{L.index.xxx}}）
    lang: '',
    L: {},
    // 评价弹窗（只给「已完成」的预约）。同一个弹窗兼「写评价」和「看/改评价」，
    // reviewExists 决定按钮文案（提交评价 / 保存修改）。
    showReview: false,
    reviewBookingId: '',
    reviewBookingLabel: '',
    reviewContent: '',
    reviewExists: false,
    reviewSubmitting: false,
  },

  onLoad() {
    this.applyLang();
    this.applyWeek(0);
    // 页面级节流状态：_loadedAt 是上次成功拉取的本地时间戳，_dirty 表示
    // 本地有过变更（下单/取消）需要下次进入时强制重拉
    this._loadedAt = 0;
    this._dirty = false;
    this.applyMode(currentMode());
  },

  onShow() {
    // 语言可能在个人中心改过。个人中心是 tab 页，切回首页必然走 onShow，
    // 所以这里重读一次语言即可，不需要订阅/发布机制。
    this.applyLang();
    // 模式每次切回来都要重算：可能在个人中心点了「化妆师入口/顾客端入口」。
    // 切回顾客端时 applyMode 会把 _loadedAt 清零，这里自然触发一次重拉。
    this.applyMode(currentMode());

    // 化妆师不需要课程表和本人资料，别白打两次云函数
    if (this.data.adminMode) return;

    // tabBar 页面每次切回来都会触发 onShow。60 秒内且本地无变更时直接跳过，
    // 避免反复切 tab 每次都打两次云函数。下拉刷新仍可强制拉取。
    const fresh = Date.now() - (this._loadedAt || 0) < LOAD_TTL;
    if (this._dirty || !this._loadedAt || !fresh) this.loadAll();
  },

  // ============ 语言 ============
  // 语言存在本地（storage 的 ui_lang），没手动选过时跟随微信系统语言。
  // 整份字典进 data.L —— WXML 不能调用 JS 函数，只能这么渲染。
  // 切 tab 回来时 onShow 必然触发，所以语言一变这边一定会重渲染。
  applyLang() {
    const lang = getLang();
    if (lang === this.data.lang) return;
    // 换语言时把注意事项图清空：data 里那个 https 临时链接指向的是**上一语言**的图，
    // 不清掉的话英文界面会先闪一张中文图。清空后下次打开时按新语言重新取。
    this.setData({ lang, L: getDict(lang), noticeImg: '', noticeLoading: false, noticeError: false });
  },

  // 统一切换整页形态：顾客预约 ⇄ 化妆师后台，并让 tabBar 文案/图标跟着变
  applyMode(mode) {
    const adminMode = mode === 'admin';
    if (adminMode !== this.data.adminMode) {
      // 切到顾客端时，旧的课表数据已过期（化妆师期间可能有变动），强制重拉
      if (!adminMode) this._loadedAt = 0;
      this.setData({ adminMode });
    }
    syncTabBar(mode);
  },

  // adminPanel 组件在退出登录或令牌过期时通知宿主切回顾客端
  onModeChange(e) {
    const mode = (e.detail && e.detail.mode) || 'customer';
    setMode(mode);
    this.applyMode(mode);
    if (mode === 'customer') this.loadAll();
  },

  onPullDownRefresh() {
    if (this.data.adminMode) {
      // 组件没有页面生命周期，下拉刷新由宿主转交
      const panel = this.selectComponent('#adminPanel');
      const p = panel ? panel.refresh() : Promise.resolve();
      Promise.resolve(p).then(() => wx.stopPullDownRefresh());
      return;
    }
    this._dirty = true; // 绕过 onShow 的 TTL
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
      await this.loadSchedule();
    } catch (e) {
      console.error('加载失败', e);
      wx.showToast({ title: t('common.loadFailed'), icon: 'none' });
    }
  },

  async loadSchedule() {
    const weekDates = this.data.weekDates;
    if (!weekDates.length) return;

    // 统一走云函数，客户端不再直连数据库。
    // 网格和「我的预约」卡片都由这一次调用的返回渲染——服务端会把本人预约
    // 完整返回，不再单独调 listMyBookings（原来每次进首页是两次云函数调用）。
    const res = await wx.cloud.callFunction({
      name: 'listWeekSchedule',
      data: { dates: weekDates.map(d => d.date) },
    });
    if (!res.result || !res.result.success) {
      throw new Error((res.result && res.result.message) || '时段加载失败');
    }

    const tsMap = {};
    (res.result.timeSlots || []).forEach(r => { tsMap[r.date] = r; });

    // 时段配置（全局三段 + 单日覆盖）。服务端随 listWeekSchedule 一起带回来，
    // 不为了取时间再多打一次云函数调用。缺字段时 normalizeSlotTimes 退回默认值。
    const slotTimes = normalizeSlotTimes(res.result.slotTimes);
    this._slotTimes = slotTimes;

    // 服务端返回的是本人全部预约（不限本周），网格只认本周且仍占用中的
    const weekSet = new Set(weekDates.map(d => d.date));
    const myBkMap = {};
    (res.result.myBookings || []).forEach(b => {
      if (!weekSet.has(b.date)) return;
      if (b.status !== 'pending' && b.status !== 'confirmed') return;
      myBkMap[`${b.date}_${b.slot}`] = b._id;
    });

    // 越晚的越靠上：日期倒序，同一天按晚上→下午→上午排。
    // 不能靠数据库 orderBy('slot','desc')，那会按字母序排成 evening/morning/afternoon
    const myBookings = (res.result.myBookings || [])
      .slice()
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        const ra = SLOT_ORDER[a.slot] == null ? -1 : SLOT_ORDER[a.slot];
        const rb = SLOT_ORDER[b.slot] == null ? -1 : SLOT_ORDER[b.slot];
        return rb - ra;
      })
      .map(b => ({
        ...b,
        // 预约自带的时间段快照才是权威值（化妆师改过时间它会跟着更新），
        // SLOT_NAME_MAP 只是它缺失时的兜底。
        slotLabel: b.slotName || SLOT_NAME_MAP[b.slot] || b.slot,
        // 评价挂在预约文档上（bookings.review），listWeekSchedule 返回整条文档，
        // 所以这里本地就能判断「评价过没有」——不用多打一次云函数调用。
        hasReview: !!(b.review && b.review.content),
      }));

    const grid = [[], [], []];
    for (let s = 0; s < SLOT_DEFS.length; s++) {
      const slotKey = SLOT_DEFS[s].key;
      for (let d = 0; d < weekDates.length; d++) {
        const day = weekDates[d];
        const key = `${day.date}_${slotKey}`;

        // 这一格的有效时间段（单日覆盖优先）和「是否被单独改过」
        const eff = resolveSlotTime(slotTimes, day.date, slotKey);
        const time = formatRange(eff);
        const custom = isCustomTime(slotTimes, day.date, slotKey);

        if (myBkMap[key]) {
          grid[s][d] = { status: 'mine', bookingId: myBkMap[key], time, tStart: eff.start, tEnd: eff.end, custom };
          continue;
        }
        // 已过去的日期一律不可预约，标「时段已过」而不是「暂未开放」——
        // 那天只是过去了，和化妆师有没有开放是两回事
        if (day.isPast) {
          grid[s][d] = { status: 'past', slotState: null, time, tStart: eff.start, tEnd: eff.end, custom };
          continue;
        }

        // 当天已过结束时刻的时段同样不可预约（如上午 10 点不能再约 09:30-11:30）。
        // 结束时刻取这一格的有效时间（配置里的值，不是写死的整数小时）。
        // 只是前端体验，服务端 createBooking 还会再校验一次。
        if (isSlotExpired(day.date, eff.end)) {
          grid[s][d] = { status: 'expired', slotState: null, time, tStart: eff.start, tEnd: eff.end, custom };
          continue;
        }

        const ts = tsMap[day.date];
        const slotState = ts ? ts[slotKey] : null;
        if (slotState && typeof slotState === 'object') {
          if (slotState.booked === true) {
            grid[s][d] = { status: 'taken', slotState, time, tStart: eff.start, tEnd: eff.end, custom };
          } else if (slotState.open !== true) {
            grid[s][d] = { status: 'locked', slotState, time, tStart: eff.start, tEnd: eff.end, custom };
          } else {
            grid[s][d] = { status: 'available', slotState, time, tStart: eff.start, tEnd: eff.end, custom };
          }
        } else {
          grid[s][d] = { status: 'locked', slotState: null, time, tStart: eff.start, tEnd: eff.end, custom };
        }
      }
    }
    // 行标题上的时间用全局配置
    this.setData({ grid, myBookings, slots: buildSlotRows(slotTimes) });
    this._loadedAt = Date.now();
    this._dirty = false;
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
    // 节流：点格子→提交预约这一串手势会连着调两次 loadProfile，
    // TTL 内直接用本地缓存，不再发云函数。保存资料后时间戳会被清掉。
    // 时间戳存在 storage 里，个人中心那个 tab 也共用它——两个 tab 各发一次
    // userProfile{get} 是纯粹的重复，那边已经渲染好同一份 storage 缓存了。
    if (Date.now() - fetchedAt() < LOAD_TTL) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'get', lang: this.data.lang },
      });
      const r = res.result;
      if (!r || !r.success || !r.profile) return;
      markFetched();
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
    const { date, slot, name, time, status, styles } = e.currentTarget.dataset;
    if (status !== 'available') return;

    const list = Array.isArray(styles) ? styles : [];
    this.setData({
      showModal: true,
      modalDate: date,
      modalSlot: slot,
      // 时段名（本地化）+ 这一格的**有效时间段**（单日覆盖优先），
      // 顾客下单前看得到准时间，不会白跑一趟
      modalInfo: `${date} ${name || ''} ${time || ''}`.trim(),
      modalStyles: list,
      selectedStyle: list.length === 1 ? 0 : -1,
    });
    this.loadProfile();
  },

  closeModal() {
    this.setData({ showModal: false });
  },

  noop() {},

  // 打开「注意事项」弹窗。success=true 是「刚下单成功」那一次弹的（标题「预约成功」）；
  // 预约卡片上的「注意事项」按钮走 success=false（标题「化妆注意事项」）。
  //
  // 只有一种情况能直接把链接塞给 <image>：**缓存里那份**。
  // 缓存 TTL（90 分钟）比临时链接本身的寿命（约 2 小时）短，所以缓存里的链接
  // 一定还没过期 —— 命中时零云函数调用。
  //
  // 缓存没命中就**留空 + 转圈**，然后去换一个新链接。
  // 这里原来还有一层 `|| this.data.noticeImg` 的兜底，是个大坑：
  // 页面实例在后台活过 2 小时后，data 里那份早就过期了，回退过去等于
  // 拿一张失效的链接去渲染 —— 线上表现为「注意事项」按钮点开一片白图。
  openNotice(success = false) {
    this._noticeRetried = false;
    const cached = this.cachedNoticeUrl();
    if (cached) {
      this.setData({
        showNotice: true,
        noticeSuccess: !!success,
        noticeImg: cached,
        noticeLoading: false,
        noticeError: false,
      });
      return;
    }
    this.setData({
      showNotice: true,
      noticeSuccess: !!success,
      noticeImg: '',
      noticeLoading: true,
      noticeError: false,
    });
    this.fetchNoticeUrl();
  },

  // 预约卡片上的「注意事项」按钮：把那张注意事项图再弹一次。
  // 顾客第一次弹出来时没长按保存，之后就找不到了 —— 这个入口就是补救。
  showNoticeTips() {
    this.openNotice(false);
  },

  // 注意事项图的缓存按语言分桶 —— 中英文是两张不同的图，
  // 混用会拿到另一种语言的临时链接。
  noticeCacheKey() {
    return `${NOTICE_CACHE_KEY}:${this.data.lang || 'zh'}`;
  },

  // 返回一个仍在有效期内的临时链接，没有则返回空串
  cachedNoticeUrl() {
    const c = wx.getStorageSync(this.noticeCacheKey());
    if (c && c.url && Date.now() - (c.at || 0) < NOTICE_TTL) return c.url;
    return '';
  },

  // 取一个新的 https 临时链接（云存储的临时链接约 2 小时后过期）。
  // 成功：写缓存 + 渲染；失败：把弹窗切到 error 态，由顾客点「重新加载」。
  async fetchNoticeUrl() {
    const lang = this.data.lang || 'zh';
    try {
      const res = await wx.cloud.callFunction({ name: 'getNoticeImage', data: { lang } });
      const r = res && res.result;
      if (!r || !r.success || !r.url) throw new Error('notice image unavailable');
      wx.setStorageSync(this.noticeCacheKey(), { url: r.url, at: Date.now() });
      this.setData({ noticeImg: r.url, noticeLoading: false, noticeError: false });
    } catch (err) {
      console.error('getNoticeImage failed:', err);
      this.setData({ noticeLoading: false, noticeError: true });
    }
  },

  // <image> 加载失败：多半是链接已过期或网络抖动。
  // 自动换一个新链接重试**一次**；再失败就退回包内备用图 + 手动重试按钮，
  // 不再自动重试 —— 免得链接一直有问题时变成死循环。
  onNoticeImageError() {
    if (this._noticeRetried) {
      this.setData({ noticeImg: '', noticeLoading: false, noticeError: true });
      return;
    }
    this._noticeRetried = true;
    this.setData({ noticeLoading: true, noticeError: false });
    this.fetchNoticeUrl();
  },

  // 弹窗里的「重新加载」按钮
  retryNotice() {
    this._noticeRetried = false;
    this.setData({ noticeImg: '', noticeLoading: true, noticeError: false });
    this.fetchNoticeUrl();
  },

  closeNotice() {
    this.setData({ showNotice: false, noticeLoading: false, noticeError: false });
  },

  onSelectStyle(e) {
    this.setData({ selectedStyle: Number(e.currentTarget.dataset.idx) });
  },

  // 第一步：不是直接下单，而是先弹个人信息表让顾客确认/补全
  async submitBooking() {
    const { nickname, modalDate, modalSlot, modalStyles, selectedStyle } = this.data;
    if (!(nickname || '').trim()) {
      return wx.showToast({ title: t('index.nicknameRequired'), icon: 'none' });
    }
    if (modalStyles.length > 0 && selectedStyle < 0) {
      return wx.showToast({ title: t('index.styleRequired'), icon: 'none' });
    }

    await this.loadProfile();
    const missing = missingFields(this.data.info, { requirePhoto: true });
    if (missing.length) {
      // missingFields() 返回的是中文字段名（与云函数 createBooking 的规则必须一致），
      // 显示时翻译成当前语言的标签。分隔符也按语言走：中文「、」英文「, 」。
      wx.showToast({ title: t('common.missing') + listJoin(missing.slice(0, 2)), icon: 'none' });
    }
    // 「想画的妆容照片」属于这一次预约，每次都要重传 → 初始值给空数组。
    // 种子先给、弹窗后开：两批 setData，组件「刚打开时重置成种子」才拿得到新值。
    this.setData({
      infoMode: 'confirm',
      infoHint: t('index.confirmHint'),
      detailBookingId: '',
      detailStyleRefs: [],
    });
    this.setData({ showInfo: true });
  },

  // 预约卡片上的“详细信息”：随时查看/更新最新个人信息，不涉及下单。
  // 「想画的妆容照片」属于**这一单**，所以要知道是哪一单（data-id）。
  async openInfoDetail(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset.id) || '';
    const booking = this.data.myBookings.find((b) => b._id === id) || null;
    await this.loadProfile();
    const refs = booking && Array.isArray(booking.styleRefPhotos) ? booking.styleRefPhotos.slice() : [];
    this.setData({
      infoMode: 'view',
      // 写清是哪一单：参考图挂在预约上，不说清楚她会以为改的是个人资料
      infoHint: booking
        ? t('index.detailHintBooking', { date: booking.date, slot: booking.slotLabel })
        : t('index.detailHint'),
      detailBookingId: booking ? booking._id : '',
      detailStyleRefs: refs,
    });
    this.setData({ showInfo: true });
  },

  closeInfo() {
    this.setData({ showInfo: false });
  },

  // 第二步：个人信息确认（并补全）通过后才真正下单
  async onSaveInfo(e) {
    // 想画的妆容照片属于**这一次预约**，不存个人资料，单独传给 createBooking。
    // 必须在第一个 await 之前取出来：组件里的数组可能在 await 期间被重置。
    const styleRefPhotos = (e.detail.styleRefPhotos || []).slice();

    // 下单前最后一个手势在这里：把订阅额度拿到手，保证
    //   ① createBooking 之后化妆师确认/拒绝时能发出去（预约结果通知）；
    //   ② 化妆师点「标记完成」时能提醒她来评价（提醒评价）。
    // 两个模板一次授权，各得 1 条额度 —— 额度是各自独立的，不互相消耗。
    // ② 这一条尤其不能省：一次性订阅没有额度就发不出去，化妆师标记完成后
    // 顾客收不到提醒，只能自己刷首页才看到「评价」按钮。
    //
    // 为什么不在 doCreateBooking 里请求：那里已经在 onSaveInfo 里 await 过
    // userProfile，跨了一次真实异步边界，部分基础库上会丢失手势上下文报
    // can only be invoked by user TAP action；而且此刻顾客正盯着信息表，
    // 突然弹订阅框观感也差。
    //
    // 必须门控 infoMode==='confirm' —— onSaveInfo 同时服务于点「详细信息」
    // 的保存场景（infoMode='view'），那条路只是保存资料，不该被问订阅。
    // 模板 ID 为空时 requestSubscribe 直接 resolve，静默跳过。
    if (this.data.infoMode === 'confirm') {
      await requestSubscribe([TPL_CUSTOMER_RESULT, TPL_CUSTOMER_REVIEW]);
    }

    const form = e.detail.info || {};
    const isConfirm = this.data.infoMode === 'confirm';

    // 老顾客复购时这份表往往一个字都没改，而 saveInfo 是一次实打实的云函数
    // 调用，写进去的内容和库里完全一样。资料没变就跳过，直接去下单。
    //
    // 只在 confirm（预约）路径上跳过：「详细信息」那条路的保存**必须**落库，
    // 否则她改了资料会看不到任何效果。
    // 万一本地缓存其实已经过期而云端判定不完整，createBooking 会返回
    // PROFILE_INCOMPLETE，页面会重新拉一次云端并把缺项回显出来——不会漏。
    if (isConfirm && sameForm(form, wx.getStorageSync('user_info'))) {
      this.setData({ showInfo: false });
      await this.doCreateBooking(styleRefPhotos);
      return;
    }

    this.setData({ submitting: true });
    const formCmp = this.selectComponent('#infoForm');
    if (formCmp) formCmp.setSubmitting(true);
    try {
      const saveRes = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'saveInfo', nickname: this.data.nickname, info: form, lang: this.data.lang },
      });
      if (!saveRes.result || !saveRes.result.success) {
        console.error('保存个人信息失败：', saveRes.result);
        wx.showToast({ title: (saveRes.result && saveRes.result.message) || t('common.saveFailed'), icon: 'none' });
        return;
      }
      const info = toForm(saveRes.result.info, this.data.nickname);
      this.setData({ info });
      wx.setStorageSync('user_info', info);
      // 资料刚变过，下次读资料必须回云端
      clearFetched();
      // 预约前确认才接着下单；单看详情只保存
      if (isConfirm) {
        this.setData({ showInfo: false });
        await this.doCreateBooking(styleRefPhotos);
        return;
      }
      // 单看详情：这一单的参考图也要落库。图没动就别发请求——
      // 云函数调用次数是稀缺的资源，不该为「没改」付费。
      if (this.data.detailBookingId && !sameList(styleRefPhotos, this.data.detailStyleRefs)) {
        const upRes = await wx.cloud.callFunction({
          name: 'updateBookingPhotos',
          data: {
            bookingId: this.data.detailBookingId,
            styleRefPhotos,
            lang: this.data.lang,
          },
        });
        if (!upRes.result || !upRes.result.success) {
          console.error('保存参考图失败：', upRes.result);
          wx.showToast({ title: (upRes.result && upRes.result.message) || t('common.saveFailed'), icon: 'none' });
          return;   // 弹窗不关，她可以直接重试
        }
        // 就地打补丁：不重拉整张预约列表
        const photos = upRes.result.styleRefPhotos || styleRefPhotos;
        this.setData({
          detailStyleRefs: photos,
          myBookings: this.data.myBookings.map((b) => (
            b._id === this.data.detailBookingId ? { ...b, styleRefPhotos: photos } : b
          )),
        });
      }
      this.setData({ showInfo: false });
      wx.showToast({ title: t('common.updated'), icon: 'success' });
    } catch (err) {
      console.error('保存个人信息异常：', err);
      wx.showToast({ title: (err && err.message) || t('common.saveFailedRetry'), icon: 'none' });
    } finally {
      if (formCmp) formCmp.setSubmitting(false);
      this.setData({ submitting: false });
    }
  },

  async doCreateBooking(styleRefPhotos = []) {
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
          // 想画的妆容照片：跟着这一单存，不进个人资料
          styleRefPhotos: styleRefPhotos || [],
          lang: this.data.lang,
        },
      });
      if (res.result && res.result.success) {
        this.setData({ showModal: false });
        this.openNotice(true);
        this.loadAll();
      } else if (res.result && res.result.code === 'NO_OPENID') {
        // 服务端拿不到身份，长文本用弹窗展示，避免 toast 截断
        wx.showModal({
          title: t('index.cannotSubmit'),
          content: res.result.message,
          showCancel: false,
        });
      } else if (res.result && res.result.code === 'PROFILE_INCOMPLETE') {
        // 服务端判定资料不完整（可能资料刚被改过、或前后端规则不同步）：
        // 重新拉一次云端，以云端为准把缺项回显在表里让用户当场补
        await this.loadProfile();
        this.setData({ showInfo: true });
        wx.showToast({ title: t('index.profileIncomplete'), icon: 'none' });
      } else {
        wx.showToast({ title: (res.result && res.result.message) || t('common.submitFailed'), icon: 'none', duration: 2500 });
        this.loadSchedule();
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: t('common.submitFailed'), icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async cancelBooking(e) {
    const { id } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: t('index.confirmCancelTitle'),
      content: t('index.confirmCancelContent'),
      confirmColor: '#C95B7C',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await wx.cloud.callFunction({
            name: 'cancelBooking',
            data: { bookingId: id, lang: that.data.lang },
          });
          if (res.result && res.result.success) {
            wx.showToast({ title: t('index.cancelled'), icon: 'success' });
            that.loadAll();
          } else {
            wx.showToast({ title: (res.result && res.result.message) || t('common.operationFailed'), icon: 'none' });
          }
        } catch (e) {
          console.error(e);
          wx.showToast({ title: t('common.operationFailed'), icon: 'none' });
        }
      },
    });
  },

  // ============ 评价 ============
  // 只有「已完成」的预约能评价。评价存在预约文档上（bookings.review），
  // 打开弹窗要用的数据本地就有 —— 一次云函数调用都不用打。
  openReview(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset.id) || '';
    const booking = this.data.myBookings.find((b) => b._id === id) || null;
    // 双保险：按钮只给已完成的单，但服务端还会再校验一次
    if (!booking || booking.status !== 'completed') return;
    const content = (booking.review && booking.review.content) || '';
    this.setData({
      showReview: true,
      reviewBookingId: booking._id,
      reviewBookingLabel: `${booking.date} ${booking.slotLabel}`,
      reviewContent: content,
      // 评价过 → 弹窗是「查看/修改」，按钮文案跟着变
      reviewExists: !!content,
    });
  },

  closeReview() {
    this.setData({
      showReview: false,
      reviewBookingId: '',
      reviewContent: '',
      reviewExists: false,
    });
  },

  onReviewInput(e) {
    this.setData({ reviewContent: e.detail.value });
  },

  async submitReview() {
    const content = (this.data.reviewContent || '').trim();
    if (!content) {
      // 空内容直接拦在本地，不浪费一次云函数调用
      return wx.showToast({ title: t('index.reviewRequired'), icon: 'none' });
    }
    const bookingId = this.data.reviewBookingId;
    if (!bookingId) return;
    // 先存下来：下面的 setData 会清掉 reviewExists
    const isUpdate = this.data.reviewExists;

    this.setData({ reviewSubmitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'submitReview',
        data: { bookingId, content, lang: this.data.lang },
      });
      if (res.result && res.result.success) {
        // 就地打补丁：不重拉整张预约列表（省一次 listWeekSchedule）
        this.setData({
          showReview: false,
          reviewContent: '',
          reviewExists: false,
          myBookings: this.data.myBookings.map((b) => (
            b._id === bookingId ? { ...b, review: { content }, hasReview: true } : b
          )),
        });
        wx.showToast({
          title: isUpdate ? t('index.reviewUpdated') : t('index.reviewSubmitted'),
          icon: 'success',
        });
      } else {
        // 服务端的拒绝理由（不是本人的单 / 不是已完成）直接透出来
        wx.showToast({
          title: (res.result && res.result.message) || t('common.saveFailed'),
          icon: 'none',
          duration: 2500,
        });
      }
    } catch (e) {
      console.error('提交评价失败', e);
      wx.showToast({ title: t('common.saveFailedRetry'), icon: 'none' });
    } finally {
      this.setData({ reviewSubmitting: false });
    }
  },
});