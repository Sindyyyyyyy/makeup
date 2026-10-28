// pages/index/index.js - 首页 v2.0.0
// 按身份渲染两套完全不同的界面：顾客看预约课表，化妆师看管理后台。
// 视图模式由 utils/role.js 的 currentMode() 判定（admin_token 与 admin_mode 分离）。
const { SLOT_DEFS, SLOT_NAME_MAP, SLOT_ORDER, computeWeekDates, isSlotExpired } = require('../../utils/slots.js');
const { emptyForm, toForm, missingFields, sameForm, fetchedAt, markFetched, clearFetched } = require('../../utils/profileInfo');
const { currentMode, syncTabBar, setMode } = require('../../utils/role.js');
const { TPL_CUSTOMER_RESULT, requestSubscribe } = require('../../utils/notify.js');
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
    slots: SLOT_DEFS.map((s, i) => ({ ...s, _idx: i })),
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
    submitting: false,
    // 预约成功后的「注意事项」图。noticeImg 默认指向包内压缩图兜底，
    // 云函数拿到 https 临时链接后会替换成可长按保存的那份
    showNotice: false,
    noticeImg: '/images/notice.jpg',
    // 界面语言。'zh' | 'en'，以及整份文案字典 L（模板里写 {{L.index.xxx}}）
    lang: '',
    L: {},
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
    // 换语言时把注意事项图退回包内兜底图：上一语言的临时链接还在 data 里，
    // 不清掉的话英文界面会先闪一张中文图。
    this.setData({ lang, L: getDict(lang), noticeImg: '/images/notice.jpg' });
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
        slotLabel: SLOT_NAME_MAP[b.slot] || b.slot,
      }));

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
        // 已过去的日期一律不可预约，标「时段已过」而不是「暂未开放」——
// 那天只是过去了，和化妆师有没有开放是两回事
        if (day.isPast) {
          grid[s][d] = { status: 'past', slotState: null };
          continue;
        }

        // 当天已过结束时刻的时段同样不可预约（如上午 10 点不能再约 09:30-11:30）。
        // 只是前端体验，服务端 createBooking 还会再校验一次。
        if (isSlotExpired(day.date, slotKey)) {
          grid[s][d] = { status: 'expired', slotState: null };
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
    this.setData({ grid, myBookings });
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

  // 预约成功后弹注意事项图。
  //
  // 顺序讲究：先用缓存或包内兜底图把弹窗点亮，**不等网络**。原实现是先 await
  // 一次云函数再 setData showNotice，弹窗被整趟往返卡住；包里已经有
  // /images/notice.jpg 兜底，完全没有理由让顾客对着空白等一秒。
  openNotice() {
    const cached = this.cachedNoticeUrl();
    this.setData({
      showNotice: true,
      noticeImg: cached || this.data.noticeImg || '/images/notice.jpg',
    });
    // 缓存没命中才去换链接；换回来后静默替换，弹窗已经在了
    if (!cached) this.fetchNoticeUrl();
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

  async fetchNoticeUrl() {
    const lang = this.data.lang || 'zh';
    try {
      const res = await wx.cloud.callFunction({ name: 'getNoticeImage', data: { lang } });
      const r = res && res.result;
      if (!r || !r.success || !r.url) return;
      wx.setStorageSync(this.noticeCacheKey(), { url: r.url, at: Date.now() });
      this.setData({ noticeImg: r.url });
    } catch (err) {
      // 保持包内兜底图：它至少显示得出来，只是长按存不到相册
      console.error('getNoticeImage failed:', err);
    }
  },

  closeNotice() {
    this.setData({ showNotice: false });
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
    // 下单前最后一个手势在这里：先把「预约结果通知」的订阅额度拿到手，
    // 保证 createBooking 之后化妆师确认/拒绝时能发出去。
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
      await requestSubscribe([TPL_CUSTOMER_RESULT]);
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
      await this.doCreateBooking();
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
      this.setData({ showInfo: false });
      // 预约前确认才接着下单；单看详情只保存
      if (isConfirm) {
        await this.doCreateBooking();
      } else {
        wx.showToast({ title: t('common.updated'), icon: 'success' });
      }
    } catch (err) {
      console.error('保存个人信息异常：', err);
      wx.showToast({ title: (err && err.message) || t('common.saveFailedRetry'), icon: 'none' });
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
          lang: this.data.lang,
        },
      });
      if (res.result && res.result.success) {
        this.setData({ showModal: false });
        this.openNotice();
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
});