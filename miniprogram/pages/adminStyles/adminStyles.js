// pages/adminStyles/adminStyles.js - 妆容管理 v1.0.0
// 维护一份全局妆造库；时段管理里开放时段时可选的按钮即来自这里

const TOKEN_KEY = 'admin_token';

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
    this.loadStyles().then(() => wx.stopPullDownRefresh());
  },

  handleAuthFail() {
    wx.removeStorageSync(TOKEN_KEY);
    this.setData({ isAdmin: false });
    wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
  },

  async loadStyles() {
    if (!this.data.isAdmin) return;
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminStyles',
        data: { action: 'list', token: wx.getStorageSync(TOKEN_KEY) },
      });
      if (res.result && res.result.success) {
        this.setData({ styles: res.result.styles || [] });
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        showResult(res.result, '加载失败');
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
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
        await this.loadStyles();
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
        await this.loadStyles();
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
