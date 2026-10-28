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

Page({
  data: {
    avatarUrl: '',
    nickname: '',
    dirty: false,
    saving: false,
    uploading: false,

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
      this.setData(this._saved);
    } else {
      this._saved = { avatarUrl: '', nickname: '' };
    }
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
      this._saved = remote;
      // 用户已经改过就别用云端值覆盖
      if (!this.data.dirty) {
        this.setData(remote);
        wx.setStorageSync(CACHE_KEY, remote);
      }

      const info = toForm(r.info, this.data.nickname);
      this._savedInfo = info;
      this.setData({ hasInfo: hasContent(info), info });
      wx.setStorageSync(INFO_CACHE_KEY, info);
    } catch (err) {
      console.error('获取个人资料失败', err);
    }
  },

  async onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl;
    if (!tempPath) return;
    // 临时路径会被清理，选中后立即上传换 fileID
    this.setData({ uploading: true });
    try {
      const ext = (tempPath.match(/\.(\w+)$/) || [, 'png'])[1];
      const cloudPath = `avatars/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
      this.setData({ avatarUrl: up.fileID });
      this.markDirty();
    } catch (err) {
      console.error('头像上传失败', err);
      wx.showToast({ title: t('profile.avatarUploadFailed'), icon: 'none' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
    this.markDirty();
  },

  markDirty() {
    const dirty = this.data.avatarUrl !== this._saved.avatarUrl
      || this.data.nickname !== this._saved.nickname;
    if (dirty !== this.data.dirty) this.setData({ dirty });
  },

  async onSave() {
    const nickname = (this.data.nickname || '').trim();
    if (!this.data.avatarUrl && !nickname) {
      wx.showToast({ title: t('profile.needAvatarOrNickname'), icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'save', nickname, avatarUrl: this.data.avatarUrl, lang: this.data.lang },
      });
      const r = res.result;
      if (!r || !r.success) {
        console.error('保存个人资料失败：', r);
        wx.showToast({ title: (r && r.message) || t('common.saveFailed'), icon: 'none' });
        return;
      }
      const saved = { avatarUrl: r.profile.avatarUrl || '', nickname: r.profile.nickname || '' };
      this._saved = saved;
      this.setData({ ...saved, dirty: false });
      wx.setStorageSync(CACHE_KEY, saved);
      // 昵称就是 users.nickname，首页读的是同一个字段，清掉时间戳强制回云端校准
      clearFetched();
      wx.showToast({ title: t('common.saved'), icon: 'success' });
    } catch (err) {
      console.error('保存个人资料异常：', err);
      wx.showToast({ title: (err && err.message) || t('common.saveFailedRetry'), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
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