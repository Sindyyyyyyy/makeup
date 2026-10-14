// pages/adminStyles/adminStyles.js - 妆容管理 v1.0.0
// 维护一份全局妆造库；时段管理里开放时段时可选的按钮即来自这里
const styleCache = require('../../utils/styleCache.js');

const TOKEN_KEY = 'admin_token';

// 本地打补丁时的排序口径：主键是 sort（云端 listStyles 也是 orderBy('sort','asc')），
  // sort 相同时按 _id 兜底，保证同一份列表每次渲染顺序一致，不会看着像在乱跳。
function sortStyles(list) {
  return list.slice().sort((a, b) => {
    const sa = typeof a.sort === 'number' ? a.sort : 0;
    const sb = typeof b.sort === 'number' ? b.sort : 0;
    if (sa !== sb) return sa - sb;
    return String(a._id || '').localeCompare(String(b._id || ''));
  });
}

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
    styles: [],
    loading: false,
    saving: false,
    editingId: '',      // 正在编辑的妆造 _id，空字符串表示新增
    form: { name: '', price: '' },
  },

  onLoad() {
    if (wx.getStorageSync(TOKEN_KEY)) {
      this.setData({ isAdmin: true });
    }
  },

  onShow() {
    if (this.data.isAdmin) this.loadStyles();
  },

  onPullDownRefresh() {
    if (!this.data.isAdmin) return wx.stopPullDownRefresh();
    // 主动下拉 = 强制绕过缓存
    this.loadStyles(true).then(() => wx.stopPullDownRefresh());
  },

  handleAuthFail() {
    wx.removeStorageSync(TOKEN_KEY);
    this.setData({ isAdmin: false });
    wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
  },

  // force=true 时绕过 styleCache（下拉刷新用）——她主动下拉就是要看云端的最新状态，
  // 哪怕本地缓存还没过期。
  async loadStyles(force) {
    if (!this.data.isAdmin) return;
    this.setData({ loading: true });
    try {
      const r = await styleCache.getStyles(force ? { maxAgeMs: 0 } : undefined);
      if (r && r.success) {
        this.setData({ styles: r.styles || [] });
      } else if (r && r.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else if (r) {
        showResult(r, '加载失败');
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 增删改成功后本地改列表并同步缓存，省掉紧随其后的那次全量 list。
  // 云函数会把受影响的那一条原样回传（_id 也包含在内），所以本地能改对。
  applyLocalStyles(styles) {
    const list = sortStyles(styles);
    this.setData({ styles: list });
    styleCache.saveStyles(list);
  },

  // 新增一条妆造该用的 sort：云函数写的是「当前集合条数」，本地用「现有最大 sort + 1」
  // 推算——两者在正常情况下相等，推算的好处是不必为此多读一次数据库。
  nextSort() {
    return this.data.styles.reduce((max, s) => {
      const v = typeof s.sort === 'number' ? s.sort : 0;
      return v > max ? v : max;
    }, 0) + 1;
  },

  // ============ 新增 / 编辑 ============
  startAdd() {
    this.setData({ editingId: '', form: { name: '', price: '' } });
  },

  startEdit(e) {
    const id = e.currentTarget.dataset.id;
    const style = this.data.styles.find(s => s._id === id);
    if (!style) return;
    this.setData({ editingId: id, form: { name: style.name, price: String(style.price) } });
  },

  cancelEdit() {
    this.setData({ editingId: '', form: { name: '', price: '' } });
  },

  onNameInput(e) { this.setData({ 'form.name': e.detail.value }); },
  onPriceInput(e) { this.setData({ 'form.price': e.detail.value }); },

  async saveStyle() {
    const { form, editingId, saving } = this.data;
    if (saving) return;
    if (!(form.name || '').trim()) {
      return wx.showToast({ title: '请输入妆造名称', icon: 'none' });
    }
    const price = Number(String(form.price).trim());
    if (!String(form.price).trim() || !isFinite(price) || isNaN(price) || price < 0) {
      return wx.showToast({ title: '请输入正确的价格', icon: 'none' });
    }

    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminStyles',
        data: {
          action: editingId ? 'update' : 'add',
          styleId: editingId,
          name: form.name.trim(),
          price,
          token: wx.getStorageSync(TOKEN_KEY),
        },
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message, icon: 'success' });
        this.setData({ editingId: '', form: { name: '', price: '' } });
        // 本地打补丁，省掉一次全量 list。部署的还是旧版云函数（没有回传 style）时
        // 退回全量拉取，行为和以前完全一样。
        const s = res.result.style;
        if (s && s._id) {
          // editingId 在上面已被清空，所以要用这次进来时记下的那一个来判断新增还是修改。
          // sort 云函数不返回（add 用「当前条数」、update 压根不碰它），由本地列表推算：
          // 新增排到末尾、修改保持原位，排序结果和下次真正拉取时一致。
          const next = editingId
            ? this.data.styles.map(x => (x._id === s._id ? { ...x, name: s.name, price: s.price } : x))
            : this.data.styles.concat([{ ...s, sort: this.nextSort() }]);
          this.applyLocalStyles(next);
        } else {
          await this.loadStyles(true);
        }
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        showResult(res.result, '保存失败');
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  async deleteStyle(e) {
    const id = e.currentTarget.dataset.id;
    const style = this.data.styles.find(s => s._id === id);
    if (!style) return;

    const r = await new Promise(resolve => {
      wx.showModal({
        title: '删除妆造？',
        content: `将从妆造库移除「${style.name}」。已开放时段里已添加的该妆造不受影响。`,
        confirmColor: '#C95B7C',
        success: resolve,
        fail: resolve,
      });
    });
    if (!r || !r.confirm) return;

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminStyles',
        data: { action: 'delete', styleId: id, token: wx.getStorageSync(TOKEN_KEY) },
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message, icon: 'success' });
        if (this.data.editingId === id) this.cancelEdit();
        const s = res.result.style;
        if (s && s._id === id) {
          this.applyLocalStyles(this.data.styles.filter(x => x._id !== id));
        } else {
          await this.loadStyles(true);
        }
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        showResult(res.result, '删除失败');
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  goBack() {
    wx.navigateBack();
  },
});
