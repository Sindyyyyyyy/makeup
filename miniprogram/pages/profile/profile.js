// pages/profile/profile.js - 个人中心（微信头像昵称 + 个人信息表 + 双端切换入口 + 语言切换）
const { emptyForm, toForm, missingFields, fetchedAt, markFetched, clearFetched } = require('../../utils/profileInfo');
const { currentMode, setMode, syncTabBarItems } = require('../../utils/role.js');
const { getLang, setLang, getDict, t } = require('../../utils/i18n.js');
const cosmeticsCache = require('../../utils/cosmeticsCache.js');

const CACHE_KEY = 'user_profile';
const INFO_CACHE_KEY = 'user_info';

// 与首页共用同一个节流窗口（见 utils/profileInfo.js 的 FETCHED_AT_KEY）。
// 顾客在首页点格子会拉一次资料，紧接着切到个人中心——原来两个 tab 各拉一次，
// 拿回来的是同一份数据。onLoad 已经把 storage 缓存渲染出来了，
// TTL 内直接跳过云端，界面不会有任何变化。
const FETCH_TTL = 60 * 1000;

// 表单是否算“填过”（决定入口显示“已填写”还是“去填写”）
function hasContent(info) {
  return missingFields(info).length > 0 || Boolean(info && info.photos && info.photos.length);
}

// 有头像或有昵称就算“登录过”。
// 没登录过的人，资料卡里只显示一个「登录」按钮，头像和昵称都不显示。
function hasProfile(p) {
  return Boolean(p && (p.avatarUrl || p.nickname));
}

Page({
  data: {
    avatarUrl: '',
    nickname: '',
    dirty: false,
    saving: false,
    uploading: false,

    // 是否已登录（有过头像或昵称）。false 时资料卡只显示「登录」按钮
    loggedIn: false,
    // 登录流程进行到哪一步：'' = 没在进行中，'nick' = 头像已授权，等昵称
    loginStep: '',
    // 昵称输入框是否聚焦。只在登录流程里短暂置 true，用来自动弹出键盘上方的
    // 「使用微信昵称」；平时必须保持 false，否则一进页面就弹键盘。
    nickFocus: false,

    hasInfo: false,
    showInfo: false,
    savingInfo: false,
    info: emptyForm(),
    // 是不是「后台视图」状态。注意不要求有令牌：没输密码时首页也停在登录框上，
    // 这时个人中心必须给一个能逃出去的「顾客端入口」。
    isAdmin: false,
    // 化妆品管理的到期角标（仅化妆师可见）。见 refreshCosmeticBadge
    cosmeticState: '去管理',
    cosmeticStateColor: '',
    // 界面语言。'zh' | 'en'，以及整份文案字典 L（模板里写 {{L.profile.xxx}}）
    lang: '',
    L: {},
  },

  onLoad() {
    this.applyLang();
    this.syncChrome();
    // 本地缓存先渲染，云端数据随后回填
    const cached = wx.getStorageSync(CACHE_KEY);
    if (cached && typeof cached === 'object') {
      this._saved = { avatarUrl: cached.avatarUrl || '', nickname: cached.nickname || '' };
    } else {
      this._saved = { avatarUrl: '', nickname: '' };
    }
    // 首屏就能判断是不是登录过：缓存里有头像或昵称 → 直接是老样子；
    // 什么都没有 → 首屏就是「登录」按钮，新用户不用等云端回包。
    this.setData({ ...this._saved, loggedIn: hasProfile(this._saved) });
    const cachedInfo = wx.getStorageSync(INFO_CACHE_KEY);
    if (cachedInfo && typeof cachedInfo === 'object') {
      this._savedInfo = toForm(cachedInfo, this.data.nickname);
      this.setData({ hasInfo: hasContent(cachedInfo), info: this._savedInfo });
    } else {
      this._savedInfo = emptyForm();
      this.setData({ info: this._savedInfo });
    }
    this.fetchProfile();
  },

  onShow() {
    // 可能在首页切了端或登录/退出，回来时入口文案要跟着变
    this.setData({ isAdmin: currentMode() === 'admin' });
    // 语言也可能在别处改过（目前只有本页面能改，但读一次更保险）。
    // 切 tab 回来时 onShow 必然触发 → 首页那边也是同样的机制刷新。
    this.applyLang();
    this.syncChrome();
    this.refreshCosmeticBadge();
  },

  onUnload() {
    // 登录流程里的昵称自动保存是定时器，页面销毁后不该再 setData
    if (this._loginSaveTimer) {
      clearTimeout(this._loginSaveTimer);
      this._loginSaveTimer = null;
    }
  },

  // ============ 语言切换 ============
  // 语言存在本地（storage 的 ui_lang）。没手动选过时跟随微信系统语言，
  // 手动选过之后就以用户的选择为准，不再被系统语言覆盖。
  applyLang() {
    const lang = getLang();
    if (lang === this.data.lang) return;
    this.setData({ lang, L: getDict(lang) });
  },

  // 导航栏标题和 tab 文案跟着语言走。
  // ⚠️ 这里只能用 syncTabBarItems（不改导航栏标题），不能用 syncTabBar ——
  // 后者会 setNavigationBarTitle，而那只作用于当前显示的页面，
  // 在个人中心调它会把标题刷成首页的「我的化妆预约」。
  syncChrome() {
    wx.setNavigationBarTitle({ title: t('nav.profile') });
    syncTabBarItems(currentMode());
  },

  onLangTap(e) {
    const lang = e.currentTarget.dataset.lang;
    if (lang !== 'zh' && lang !== 'en') return;
    if (lang === this.data.lang) return;
    setLang(lang);
    this.applyLang();
    this.syncChrome();
  },

  // 化妆品管理的到期角标。**只读 storage 缓存，绝不为这个数字发云函数调用**——
  // 它只是个「有没有东西过期」的提示，不值得花一次调用。缓存空（还没进过
  // 化妆品页）时显示「去管理」。从化妆品页返回会重跑 onShow，那时缓存刚被
  // 那边写新，数字自然是最新的，整个闭环零额外调用。
  refreshCosmeticBadge() {
    if (currentMode() !== 'admin') return;
    const list = cosmeticsCache.readCache() || [];
    const s = cosmeticsCache.summarize(list);
    this.setData({
      cosmeticState: cosmeticsCache.summaryText(s),
      // 有已过期就红，只剩临期就橙，都没有就沿用粉色默认
      cosmeticStateColor: s.expired > 0 ? '#C62828' : (s.soon > 0 ? '#E86A17' : ''),
    });
  },

  openCosmetics() {
    wx.navigateTo({ url: '/pages/adminCosmetics/adminCosmetics' });
  },

  // ============ 资料 ============
  async fetchProfile() {
    // 节流：与首页共享时间戳，60 秒内已经拉过就不必再打一次云函数。
    // onLoad 已用 storage 缓存完成了首屏渲染，跳过时界面不会缺东西。
    if (Date.now() - fetchedAt() < FETCH_TTL) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'get', lang: this.data.lang },
      });
      const r = res.result;
      if (r && r.code === 'NO_OPENID') {
        console.warn('未取到 openid，请在开发者工具中确认已登录微信账号');
        return;
      }
      if (!r || !r.success) return;
      markFetched();
      const remote = {
        avatarUrl: (r.profile && r.profile.avatarUrl) || '',
        nickname: (r.profile && r.profile.nickname) || '',
      };
      // 用户已经改过就别用云端值覆盖。
      // 有未保存的改动时连 _saved 也不能动 —— 它是「已保存」的基准线，
      // 被云端的旧值冲掉会把 dirty 判断弄乱（登录流程进行中就靠它）。
      if (!this.data.dirty) {
        this._saved = remote;
        // loggedIn 只从 false 变 true，不会变回去：云端有资料就说明登录过
        this.setData({ ...remote, loggedIn: this.data.loggedIn || hasProfile(remote) });
        wx.setStorageSync(CACHE_KEY, remote);
      } else if (hasProfile(remote)) {
        // 登录流程进行中（dirty=true），别把界面打回「登录」态
        this.setData({ loggedIn: true });
      }

      const info = toForm(r.info, this.data.nickname);
      this._savedInfo = info;
      this.setData({ hasInfo: hasContent(info), info });
      wx.setStorageSync(INFO_CACHE_KEY, info);
    } catch (err) {
      console.error('获取个人资料失败', err);
    }
  },

  // ============ 头像 ============
  // 头像的临时路径会被清理，选中后必须立即上传换 fileID
  async uploadAvatar(tempPath) {
    this.setData({ uploading: true });
    try {
      const ext = (tempPath.match(/\.(\w+)$/) || [, 'png'])[1];
      const cloudPath = `avatars/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
      return up.fileID || '';
    } catch (err) {
      console.error('头像上传失败', err);
      wx.showToast({ title: t('profile.avatarUploadFailed'), icon: 'none' });
      return '';
    } finally {
      this.setData({ uploading: false });
    }
  },

  // 已登录后单独点头像：只换头像，改完按「保存资料」落库（老行为不变）
  async onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl;
    if (!tempPath) return;
    const fileID = await this.uploadAvatar(tempPath);
    if (!fileID) return;
    this.setData({ avatarUrl: fileID });
    this.markDirty();
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
    this.markDirty();
    // 登录流程中：昵称一填上就自动落库，顾客不用再按一次「保存资料」
    if (this.data.loginStep === 'nick') this.scheduleLoginSave();
  },

  markDirty() {
    const dirty = this.data.avatarUrl !== this._saved.avatarUrl
      || this.data.nickname !== this._saved.nickname;
    if (dirty !== this.data.dirty) this.setData({ dirty });
  },

  // ============ 首次登录 ============
  // 登录按钮本身就是 open-type="chooseAvatar" 的按钮：点它直接调起微信头像选择器，
  // 顾客在弹层里选「微信头像」＝ 授权微信头像。
  // ⚠️ 微信自 2022-10-25 起收回 wx.getUserProfile，一次授权拿不到「头像+昵称」两个字段，
  // 所以昵称只能靠官方现行能力：input type="nickname" 聚焦后键盘上方自带
  // 「使用微信昵称」。这里在头像授权完成后自动聚焦那个输入框，两个授权连成一次登录。
  async onLoginChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl;
    if (!tempPath) return;
    const fileID = await this.uploadAvatar(tempPath);
    if (!fileID) return;
    // 头像授权完成 → 切到资料态，并把昵称输入框聚焦，等顾客在键盘上点「使用微信昵称」
    this.setData({ avatarUrl: fileID, loggedIn: true, loginStep: 'nick', nickFocus: false });
    this.markDirty();
    // 等微信的头像弹层彻底关闭再聚焦，否则 iOS 上键盘弹不出来
    setTimeout(() => {
      if (this.data.loginStep === 'nick') this.setData({ nickFocus: true });
    }, 300);
    // 头像先落库：即使顾客没填昵称就走人，头像也不会丢
    await this.saveProfile({ silent: true });
  },

  // 登录流程里的昵称自动保存要防抖，否则手动打字时每敲一个字就发一次云函数
  scheduleLoginSave() {
    if (this._loginSaveTimer) clearTimeout(this._loginSaveTimer);
    this._loginSaveTimer = setTimeout(() => {
      this._loginSaveTimer = null;
      this.finishLogin();
    }, 600);
  },

  // 昵称齐了就算登录完成：落库 + 收尾（退出登录流程，提示一句）
  async finishLogin() {
    if (this.data.loginStep !== 'nick') return;
    if (!(this.data.nickname || '').trim()) return;
    const ok = await this.saveProfile({ silent: true });
    if (!ok) return;
    this.setData({ loginStep: '', nickFocus: false });
    wx.showToast({ title: t('profile.loginSuccess'), icon: 'success' });
  },

  // ============ 保存 ============
  // 保存必须**串行**。登录流程里「头像刚落库、昵称又跟上」会连着发两次 save，
  // 并发的话后到的请求会把先到的覆盖掉 —— 昵称那次若先到、头像那次后到，
  // users.nickname 就被那次空昵称抹掉了。用一条 Promise 链保证后一次在前一次之后发。
  saveProfile(opts) {
    const run = () => this.doSave(opts);
    this._saveChain = (this._saveChain || Promise.resolve()).then(run, run);
    return this._saveChain;
  },

  // opts.silent = 不弹成功提示（登录流程里的自动保存用，流程结束统一提示一次）
  async doSave(opts) {
    const silent = !!(opts && opts.silent);
    const nickname = (this.data.nickname || '').trim();
    if (!this.data.avatarUrl && !nickname) {
      if (!silent) wx.showToast({ title: t('profile.needAvatarOrNickname'), icon: 'none' });
      return false;
    }
    this.setData({ saving: true });
    // 记住这次发出去的值：回包只覆盖「发出去那一刻」的内容，
    // 顾客在等回包期间又改了昵称的话，不能被这次回包冲掉
    // （登录流程里正好是这种时序：头像刚落库，昵称正在输入）
    const sentAvatar = this.data.avatarUrl;
    const sentNickname = nickname;
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'save', nickname: sentNickname, avatarUrl: sentAvatar, lang: this.data.lang },
      });
      const r = res.result;
      if (!r || !r.success) {
        console.error('保存个人资料失败：', r);
        // 失败一定要让顾客看见：登录流程里的自动保存是静默的，
        // 没有这一句就会变成「头像都选好了却没存上」而毫无提示
        wx.showToast({ title: (r && r.message) || t('common.saveFailed'), icon: 'none' });
        return false;
      }
      const saved = { avatarUrl: r.profile.avatarUrl || '', nickname: r.profile.nickname || '' };
      this._saved = saved;
      const patch = { loggedIn: true };
      if (this.data.avatarUrl === sentAvatar) patch.avatarUrl = saved.avatarUrl;
      if ((this.data.nickname || '').trim() === sentNickname) patch.nickname = saved.nickname;
      this.setData(patch);
      // 用新的基准线重算：期间改过的字段仍然是「未保存」，保存按钮要点亮
      this.markDirty();
      wx.setStorageSync(CACHE_KEY, saved);
      // 昵称就是 users.nickname，首页读的是同一个字段，清掉时间戳强制回云端校准
      clearFetched();
      // 成功提示才受 silent 控制（登录流程结束时统一提示一次「登录成功」）
      if (!silent) wx.showToast({ title: t('common.saved'), icon: 'success' });
      return true;
    } catch (err) {
      console.error('保存个人资料异常：', err);
      wx.showToast({ title: (err && err.message) || t('common.saveFailedRetry'), icon: 'none' });
      return false;
    } finally {
      this.setData({ saving: false });
    }
  },

  async onSave() {
    await this.saveProfile();
  },

  // ============ 个人信息表（组件 info-form） ============
  openInfo() {
    this.setData({ showInfo: true, info: this._savedInfo || emptyForm() });
  },

  closeInfo() {
    this.setData({ showInfo: false });
  },

  // 组件把整份表单交回来，这里只负责存
  async onSaveInfo(e) {
    const form = e.detail.info || {};
    if (form.hasAllergy === '有' && !(form.allergyNote || '').trim()) {
      // 过敏只答“有”没说明对化妆师没用，提示但不阻断
      wx.showToast({ title: t('profile.allergyNoteHint'), icon: 'none' });
    }
    this.setData({ savingInfo: true });
    const formCmp = this.selectComponent('#infoForm');
    if (formCmp) formCmp.setSubmitting(true);
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'saveInfo', nickname: this.data.nickname, info: form, lang: this.data.lang },
      });
      const r = res.result;
      if (!r || !r.success) {
        console.error('保存个人信息失败：', r);
        wx.showToast({ title: (r && r.message) || t('common.saveFailed'), icon: 'none' });
        return;
      }
      const saved = toForm(r.info, this.data.nickname);
      this._savedInfo = saved;
      wx.setStorageSync(INFO_CACHE_KEY, saved);
      // 资料刚变过：清掉共享时间戳，首页下次读资料必须回云端
      clearFetched();
      this.setData({ showInfo: false, info: saved, hasInfo: hasContent(saved) });
      wx.showToast({ title: t('common.saved'), icon: 'success' });
    } catch (err) {
      console.error('保存个人信息异常：', err);
      wx.showToast({ title: (err && err.message) || t('common.saveFailedRetry'), icon: 'none' });
    } finally {
      if (formCmp) formCmp.setSubmitting(false);
      this.setData({ savingInfo: false });
    }
  },

  // ============ 双端切换 ============
  // 顾客 → 化妆师：先进独立的登录页（没有底部菜单），输对密码才落到后台。
  // 这里刻意不改模式——点进来不等于已经登录，改了就得考虑怎么撤销。
  goAdmin() {
    wx.navigateTo({ url: '/pages/adminLogin/adminLogin' });
  },

  // 化妆师 → 顾客：只是换个视图，令牌保留，来回切不用重新输密码。
  // 首页是 tab 页，必须 switchTab，navigateTo 到不了。
  goCustomer() {
    setMode('customer');
    wx.switchTab({ url: '/pages/index/index' });
  },
});