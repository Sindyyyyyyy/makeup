// pages/profile/profile.js - 个人中心（微信头像昵称 + 个人信息表 + 化妆师入口）
const CACHE_KEY = 'user_profile';
const INFO_CACHE_KEY = 'user_info';
const MAX_PHOTOS = 5;

// 表单是否算“填过”（决定入口显示“已填写”还是“去填写”）
function hasContent(info) {
  if (!info) return false;
  return Boolean(info.gender || info.skinType || info.sensitiveLevel || info.hasAcne
    || info.hasCosmeticSurgery || info.hasAllergy || (info.photos && info.photos.length));
}

const EMPTY_FORM = {
  nickname: '',
  gender: '',
  skinType: '',
  sensitiveLevel: '',
  hasAcne: '',
  hasCosmeticSurgery: '',
  hasAllergy: '',
  allergyNote: '',
  photos: [],
};

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
    maxPhotos: MAX_PHOTOS,
    genderOptions: ['男', '女'],
    skinOptions: ['干性', '油性', '混合性', '敏感性', '中性'],
    yesNoOptions: ['有', '无'],
    form: { ...EMPTY_FORM, photos: [] },
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
      this._savedInfo = cachedInfo;
      this.setData({ hasInfo: hasContent(cachedInfo) });
    } else {
      this._savedInfo = { ...EMPTY_FORM, photos: [] };
    }
    this.fetchProfile();
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

      const info = { ...EMPTY_FORM, ...(r.info || {}), photos: (r.info && r.info.photos) || [] };
      this._savedInfo = info;
      this.setData({ hasInfo: hasContent(info) });
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

  // ============ 个人信息表 ============
  openInfo() {
    const saved = this._savedInfo || EMPTY_FORM;
    this.setData({
      showInfo: true,
      form: {
        ...EMPTY_FORM,
        ...saved,
        photos: (saved.photos || []).slice(),
        // 昵称唯一来源是顶部，这里只读同步，不再让用户填第二遍
        nickname: this.data.nickname || saved.nickname || '',
      },
    });
  },

  closeInfo() {
    this.setData({ showInfo: false });
  },

  noop() {},

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onChipTap(e) {
    const { group, value } = e.currentTarget.dataset;
    if (!group) return;
    // 再点一次已选项 = 取消选择
    const cur = this.data.form[group];
    const next = cur === value ? '' : value;
    const patch = { [`form.${group}`]: next };
    // 改成“无”时顺手清掉过敏说明，避免留下无意义的文本
    if (group === 'hasAllergy' && next !== '有') patch['form.allergyNote'] = '';
    // 肤质不是敏感性时，敏感性程度同样失去意义
    if (group === 'skinType' && next !== '敏感性') patch['form.sensitiveLevel'] = '';
    this.setData(patch);
  },

  async onAddPhoto() {
    const remain = MAX_PHOTOS - this.data.form.photos.length;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_PHOTOS} 张`, icon: 'none' });
      return;
    }
    try {
      const res = await wx.chooseMedia({
        count: remain,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
      });
      const files = (res.tempFiles || []).slice(0, remain);
      if (!files.length) return;
      wx.showLoading({ title: '上传中', mask: true });
      // 临时路径会被清理，选中后立即上传换 fileID
      const uploaded = [];
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const ext = ((f.tempFilePath || '').match(/\.(\w+)$/) || [, 'jpg'])[1];
        const cloudPath = `bareface/${Date.now()}-${i}-${Math.floor(Math.random() * 100000)}.${ext}`;
        const up = await wx.cloud.uploadFile({ cloudPath, filePath: f.tempFilePath });
        uploaded.push(up.fileID);
      }
      wx.hideLoading();
      this.setData({ 'form.photos': this.data.form.photos.concat(uploaded) });
    } catch (err) {
      wx.hideLoading();
      // 用户主动取消不算错误
      if (err && /cancel/i.test(err.errMsg || '')) return;
      console.error('素颜照上传失败', err);
      wx.showToast({ title: '照片上传失败', icon: 'none' });
    }
  },

  onDeletePhoto(e) {
    const idx = e.currentTarget.dataset.idx;
    const photos = this.data.form.photos.slice();
    photos.splice(idx, 1);
    this.setData({ 'form.photos': photos });
  },

  async onSaveInfo() {
    const form = this.data.form;
    if (form.hasAllergy === '有' && !(form.allergyNote || '').trim()) {
      // 过敏只答“有”没说明对化妆师没用，提示但不阻断
      wx.showToast({ title: '建议写明过敏的具体产品', icon: 'none' });
    }
    this.setData({ savingInfo: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'userProfile',
        data: { action: 'saveInfo', nickname: form.nickname, info: form },
      });
      const r = res.result;
      if (!r || !r.success) {
        console.error('保存个人信息失败：', r);
        wx.showToast({ title: (r && r.message) || '保存失败', icon: 'none' });
        return;
      }
      const saved = { ...EMPTY_FORM, ...(r.info || {}) };
      this._savedInfo = saved;
      wx.setStorageSync(INFO_CACHE_KEY, saved);
      this.setData({ showInfo: false, hasInfo: hasContent(saved) });
      // 昵称与顶部共用同一字段，保存后同步刷新顶部。
      // 注意只更新 nickname：头像可能还没保存，不能把它一并标记成已存，
      // 否则顶部“保存资料”按钮会被误置灰。
      const nickname = r.nickname || '';
      this._saved = { ...this._saved, nickname };
      this.setData({ nickname });
      this.markDirty();
      wx.setStorageSync(CACHE_KEY, { avatarUrl: this._saved.avatarUrl, nickname });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      console.error('保存个人信息异常：', err);
      wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ savingInfo: false });
    }
  },

  // ============ 化妆师入口 ============
  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },
});