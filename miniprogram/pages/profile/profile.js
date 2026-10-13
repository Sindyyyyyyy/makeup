// pages/profile/profile.js - 个人中心（微信头像昵称 + 个人信息表 + 双端切换入口）
const { emptyForm, toForm, missingFields } = require('../../utils/profileInfo');
const { currentMode, setMode } = require('../../utils/role.js');

const CACHE_KEY = 'user_profile';
const INFO_CACHE_KEY = 'user_info';

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
  },

  onLoad() {
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
  },

  // ============ 资料 ============
  async fetchProfile() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'get' },
      });
      const r = res.result;
      if (r && r.code === 'NO_OPENID') {
        console.warn('未取到 openid，请在开发者工具中确认已登录微信账号');
        return;
      }
      if (!r || !r.success) return;
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
      wx.showToast({ title: '头像上传失败', icon: 'none' });
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
      wx.showToast({ title: '请先设置头像或昵称', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'save', nickname, avatarUrl: this.data.avatarUrl },
      });
      const r = res.result;
      if (!r || !r.success) {
        console.error('保存个人资料失败：', r);
        wx.showToast({ title: (r && r.message) || '保存失败', icon: 'none' });
        return;
      }
      const saved = { avatarUrl: r.profile.avatarUrl || '', nickname: r.profile.nickname || '' };
      this._saved = saved;
      this.setData({ ...saved, dirty: false });
      wx.setStorageSync(CACHE_KEY, saved);
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      console.error('保存个人资料异常：', err);
      wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' });
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
      wx.showToast({ title: '建议写明过敏的具体产品', icon: 'none' });
    }
    this.setData({ savingInfo: true });
    const formCmp = this.selectComponent('#infoForm');
    if (formCmp) formCmp.setSubmitting(true);
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'saveInfo', nickname: this.data.nickname, info: form },
      });
      const r = res.result;
      if (!r || !r.success) {
        console.error('保存个人信息失败：', r);
        wx.showToast({ title: (r && r.message) || '保存失败', icon: 'none' });
        return;
      }
      const saved = toForm(r.info, this.data.nickname);
      this._savedInfo = saved;
      wx.setStorageSync(INFO_CACHE_KEY, saved);
      this.setData({ showInfo: false, info: saved, hasInfo: hasContent(saved) });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      console.error('保存个人信息异常：', err);
      wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' });
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