// pages/adminNotices/adminNotices.js - 注意事项管理
// 顾客预约成功后会弹出这些图（多张时可以左右滑动）。
// 图存在云存储 notice/ 目录，记录存在数据库集合 noticeImages，
// 增删排序都走 adminNoticeImages 云函数。
//
// 中英文各一组：顾客按自己的界面语言取对应那组，该组为空时回退中文那组。
// 每组最多 5 张（服务端硬限制，这里的按钮只是第一层）。
const { isLoggedIn, clearAdmin, getToken } = require('../../utils/role.js');

const MAX_PER_LANG = 5;

// 「操作说明」的正文。整段存成一个用 \n 连起来的字符串，而不是逐条 <view>：
// <text> 组件会把 \n 渲染成换行，这样 -webkit-line-clamp 才能精确地按「行」
// 截断（拆成多个子节点时它们会变成 flex item，截断粒度会变成「条」而不是「行」）。
const TIPS_TEXT = [
  '· 顾客预约成功后会弹出这些图片，有多张时可以左右滑动查看',
  '· 中英文各一组，顾客按自己的界面语言看对应那组；那组为空就看中文组',
  '· 每组最多 5 张，传满后先删掉一张再传',
  '· 上移 / 下移调整顺序，顺序就是顾客看到的先后',
].join('\n');

// toast 会截断长文本，这类环境/配置类报错改用弹窗完整展示
function showResult(res, okFallback) {
  const message = (res && res.message) || okFallback;
  if (message.length > 18) {
    wx.showModal({ title: '提示', content: message, showCancel: false });
  } else {
    wx.showToast({ title: message, icon: 'none' });
  }
}

Page({
  data: {
    isAdmin: false,
    loading: false,
    uploading: false,

    // 当前在管哪一组
    lang: 'zh',
    // 全部图片（两种语言都在里面），list 是当前语言那一组的视图
    all: [],
    list: [],
    maxPerLang: MAX_PER_LANG,

    // 底部「操作说明」默认收起（只露两行），点标题右边的三角展开/收起
    tipsExpanded: false,
    tipsText: TIPS_TEXT,
  },

  onLoad() {
    this.setData({ isAdmin: isLoggedIn() });
  },

  onShow() {
    if (this.data.isAdmin) this.load();
  },

  handleAuthFail() {
    clearAdmin();
    this.setData({ isAdmin: false, all: [], list: [] });
    wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
  },

  async load() {
    if (!this.data.isAdmin) return;
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminNoticeImages',
        data: { action: 'list', token: getToken() },
      });
      const r = res && res.result;
      if (r && r.success) {
        this.setData({
          all: r.images || [],
          maxPerLang: r.maxPerLang || MAX_PER_LANG,
        }, () => this.applyView());
      } else if (r && r.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        showResult(r, '加载失败');
      }
    } catch (err) {
      console.error('注意事项加载失败', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 视图：只留当前语言那一组，并按 sort 排好（与服务端同一套顺序规则）。
  applyView() {
    const lang = this.data.lang;
    const list = this.data.all
      .filter((x) => x.lang === lang)
      .slice()
      .sort((a, b) => {
        const sa = typeof a.sort === 'number' ? a.sort : 0;
        const sb = typeof b.sort === 'number' ? b.sort : 0;
        if (sa !== sb) return sa - sb;
        return String(a.id).localeCompare(String(b.id));
      });
    this.setData({ list });
  },

  onLangTap(e) {
    const lang = e.currentTarget.dataset.lang;
    if (lang !== 'zh' && lang !== 'en') return;
    if (lang === this.data.lang) return;
    this.setData({ lang }, () => this.applyView());
  },

  // ============ 上传 ============
  async chooseAndUpload() {
    if (this.data.uploading) return;
    if (this.data.list.length >= this.data.maxPerLang) {
      return wx.showToast({ title: `最多 ${this.data.maxPerLang} 张`, icon: 'none' });
    }

    let tempPath = '';
    try {
      const chosen = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
      });
      tempPath = chosen && chosen.tempFiles && chosen.tempFiles[0] && chosen.tempFiles[0].tempFilePath;
    } catch (e) {
      return; // 用户取消
    }
    if (!tempPath) return;

    this.setData({ uploading: true });
    let fileID = '';
    try {
      const ext = (tempPath.match(/\.(\w+)$/) || [, 'jpg'])[1].toLowerCase();
      const cloudPath = `notice/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
      fileID = up.fileID || '';
      if (!fileID) throw new Error('上传失败');

      const res = await wx.cloud.callFunction({
        name: 'adminNoticeImages',
        data: { action: 'add', lang: this.data.lang, fileID, token: getToken() },
      });
      const r = res && res.result;
      if (r && r.success) {
        const img = r.image || {
          id: '', lang: this.data.lang, fileID, url: '', sort: this.data.list.length,
        };
        // 就地打补丁：新增的这张排在最后，不用再全量拉一次
        this.setData({ all: this.data.all.concat([img]) }, () => this.applyView());
        wx.showToast({ title: r.message || '已上传', icon: 'success' });
      } else if (r && r.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        showResult(r, '上传失败');
        this.cleanupUpload(fileID);
      }
    } catch (e) {
      console.error('注意事项上传失败', e);
      wx.showToast({ title: '上传失败', icon: 'none' });
      this.cleanupUpload(fileID);
    } finally {
      this.setData({ uploading: false });
    }
  },

  // 库里没写进去的图片留在云存储就是垃圾，顺手删掉。
  // 只是尽力而为：删不掉也不影响功能，所以不提示。
  cleanupUpload(fileID) {
    if (!fileID) return;
    try {
      wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {});
    } catch (e) {
      // 忽略
    }
  },

  // ============ 删除 ============
  async removeImage(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.all.find((x) => x.id === id);
    if (!item) return;

    const r = await new Promise((resolve) => {
      wx.showModal({
        title: '删除这张注意事项？',
        content: '顾客将不再看到这张图片。',
        confirmColor: '#C95B7C',
        success: resolve,
        fail: resolve,
      });
    });
    if (!r || !r.confirm) return;

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminNoticeImages',
        data: { action: 'delete', id, token: getToken() },
      });
      const rr = res && res.result;
      if (rr && rr.success) {
        this.setData({ all: this.data.all.filter((x) => x.id !== id) }, () => this.applyView());
        wx.showToast({ title: rr.message || '已删除', icon: 'success' });
      } else if (rr && rr.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        showResult(rr, '删除失败');
      }
    } catch (err) {
      console.error('注意事项删除失败', err);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  // ============ 排序（上移 / 下移）============
  async moveImage(e) {
    const id = e.currentTarget.dataset.id;
    const dir = e.currentTarget.dataset.dir === 'down' ? 'down' : 'up';
    const list = this.data.list;
    const idx = list.findIndex((x) => x.id === id);
    const target = dir === 'down' ? idx + 1 : idx - 1;
    if (idx < 0) return;
    if (target < 0 || target >= list.length) {
      return wx.showToast({ title: dir === 'down' ? '已经是最后一张了' : '已经是第一张了', icon: 'none' });
    }

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminNoticeImages',
        data: { action: 'move', id, dir, lang: this.data.lang, token: getToken() },
      });
      const r = res && res.result;
      if (r && r.success) {
        // 本地把两张的 sort 互换，顺序就跟着变了（与服务端同一套规则）
        const a = list[idx];
        const b = list[target];
        const all = this.data.all.map((x) => {
          if (x.id === a.id) return { ...x, sort: b.sort };
          if (x.id === b.id) return { ...x, sort: a.sort };
          return x;
        });
        this.setData({ all }, () => this.applyView());
      } else if (r && r.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        showResult(r, '调整顺序失败');
      }
    } catch (err) {
      console.error('注意事项排序失败', err);
      wx.showToast({ title: '调整顺序失败', icon: 'none' });
    }
  },

  // 点缩略图看大图
  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    const urls = this.data.list.map((x) => x.url).filter(Boolean);
    wx.previewImage({ urls, current: url });
  },

  // 「操作说明」展开/收起。纯本地状态，不发任何云函数调用。
  toggleTips() {
    this.setData({ tipsExpanded: !this.data.tipsExpanded });
  },

  goBack() {
    wx.navigateBack();
  },
});
