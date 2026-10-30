// pages/adminCosmetics/adminCosmetics.js - 化妆品管理
// 维护一份全化妆师共用的化妆品库：品牌、种类、色号、适用妆造、效期、数量、照片。
//
// 这份库有它自己的两个特点，页面的大部分设计都是冲着它们去的：
//   ① 字段多（十来个），录入一次很久 —— 所以表单放**底部**，一进来先看到库存；
//   ② 条目多且要反复筛选 —— 所以整份库一次拉下来缓存住，
//      筛选/分组/搜索全在本地算，**一次云调用都不发**。
const expiry = require('../../utils/expiry.js');
const cosmeticsCache = require('../../utils/cosmeticsCache.js');
const styleCache = require('../../utils/styleCache.js');
const { isLoggedIn, clearAdmin, getToken } = require('../../utils/role.js');

// 种类枚举。与 cloudfunctions/adminCosmetics/index.js 的 CATEGORIES 一致
// （不共享模块：miniprogram/ 与 cloudfunctions/ 不在彼此的文件系统里）。
const CATEGORIES = [
  '口红', '粉底', '粉饼', '遮瑕', '定妆粉', '腮红', '眉笔',
  '眼线笔', '眼影', '睫毛膏', '定妆喷雾', '卸妆', '其他',
];

const GROUP_BY_OPTIONS = [
  { key: 'none', label: '不分组' },
  { key: 'category', label: '按种类' },
  { key: 'style', label: '按妆造' },
];

// 效期分档的配色，hex 全部取自仓库已有的状态色
// （.bd-status.rejected 的 #C62828 / .bd-status.pending 的 #E89508 一脉相承）
const LEVEL_TEXT = {
  expired: '已过期',
  soon3: '3 个月内',
  soon6: '6 个月内',
  ok: '正常',
  none: '无保期',
};
const LEVEL_COLOR = {
  expired: '#C62828',
  soon3: '#E86A17',
  soon6: '#B8860B',
  ok: '#4A4A4A',
  none: '#B0A0A0',
};
const LEVEL_BG = {
  expired: '#FFEBEE',
  soon3: '#FFF3E0',
  soon6: '#FFFBEA',
  ok: '#F7F7F7',
  none: '#F7F7F7',
};
const LEVEL_RANK = { expired: 0, soon3: 1, soon6: 2, ok: 3, none: 4 };

const GROUP_UNLABELED = '未标注妆造';

// 「操作说明」的正文。整段存成一个用 \n 连起来的字符串，而不是逐条 <view>：
// <text> 组件会把 \n 渲染成换行，这样 -webkit-line-clamp 才能精确地按「行」
// 截断（拆成多个子节点时它们会变成 flex item，截断粒度会变成「条」而不是「行」）。
const TIPS_TEXT = [
  '· 填「生产日期 + 保质期」自动算到期日；填「到期日」加生产日期则反推保质期',
  '· 已过期和临期的会排在最前面，用完的自动沉到最底部并变灰',
  '· 适用妆造来自「妆容管理」的妆造库，不打标也可以，筛不出来而已',
  '· 筛选、搜索、分组都在本机算，随便点，不消耗云函数次数',
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

function emptyForm() {
  return {
    name: '', brand: '', category: '', shade: '',
    styles: [], produceDate: '', shelfMonths: '', expireDate: '',
    qty: '', remain: '', photo: '', note: '',
    expiryMode: 'produce',   // 'produce' 生产日期+保质期 | 'expire' 直接填到期日
  };
}

// 列表的职责是「今天该处理什么」：
//   用完的条目是死重，沉到最底（同时整行灰掉）；
//   可用条目按 已过期 → 距到期最近 → 最新 排；
//   无保期的排在正常之后，因为它最不紧急。
// 最后用 _id 兜底，避免相同 createTime 时列表视觉跳动。
function cmpCosmetics(a, b) {
  const outA = a.out ? 1 : 0;
  const outB = b.out ? 1 : 0;
  if (outA !== outB) return outA - outB;
  const ra = LEVEL_RANK[a.level];
  const rb = LEVEL_RANK[b.level];
  if (ra !== rb) return ra - rb;
  if (a.level !== 'none' && a.expireDate !== b.expireDate) {
    return a.expireDate < b.expireDate ? -1 : 1;
  }
  if (a.createTimeMs !== b.createTimeMs) return b.createTimeMs - a.createTimeMs;
  return String(a._id).localeCompare(String(b._id));
}

// 分组键。样式名只取 activeStyles（与当前妆造库取过交集的），
// 所以一个已被删除的妆造永远产生不了幽灵分组；没打标的归到一组。
function groupKeysOf(item, groupBy) {
  if (groupBy === 'category') return [item.category];
  const tags = item.activeStyles || [];
  return tags.length ? tags : [GROUP_UNLABELED];
}

function buildGroups(items, groupBy) {
  const map = new Map();
  items.forEach(item => {
    groupKeysOf(item, groupBy).forEach(key => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
  });
  const arr = Array.from(map, ([key, list]) => ({ key, label: key, count: list.length, items: list }));
  arr.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  return arr;
}

Page({
  data: {
    isAdmin: false,
    loading: false,
    saving: false,
    uploading: false,

    categories: CATEGORIES,
    categoryIndex: 0,     // 种类 picker 的选中下标
    groupByOptions: GROUP_BY_OPTIONS,

    list: [],       // 原始文档数组（缓存里的那份形状）
    groups: [],     // 派生：[{ key, label, count, items }]
    visibleCount: 0, // 当前筛选下命中的条数（空态判断用，避免在 WXML 里越界取下标）

    // 筛选态，五个都是「加」的合取条件，各自独立
    category: '',       // '' = 全部
    style: '',          // '' = 全部
    groupBy: 'none',
    keyword: '',
    onlyUnused: false,
    filterOn: false,     // 任一筛选条件生效（供「清空筛选」按钮显隐）

    styleNames: [],     // 妆造库当前名（来自 styleCache），多选和筛选的来源
    styleChips: [],     // [{ name, active }]，渲染用

    totalCount: 0,
    expiredCount: 0,
    soonCount: 0,

    editingId: '',
    form: emptyForm(),
    formHint: '',
    formStyles: [],     // [{ name, active }]，多选 chip 的渲染形状
    // 底部「操作说明」默认收起（只露两行），点标题右边的三角展开/收起
    tipsExpanded: false,
    tipsText: TIPS_TEXT,
  },

  onLoad() {
    this.setData({ isAdmin: isLoggedIn() });
  },

  onShow() {
    if (this.data.isAdmin) this.loadAll();
  },

  onPullDownRefresh() {
    if (!this.data.isAdmin) return wx.stopPullDownRefresh();
    // 主动下拉 = 强制绕过缓存：她要的就是云端的最新状态
    this.loadCosmetics(true).then(() => wx.stopPullDownRefresh());
  },

  handleAuthFail() {
    clearAdmin();
    this.setData({ isAdmin: false, list: [], groups: [] });
    wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
  },

  // 化妆品库和妆造库互不依赖，并发拉取省掉一个完整往返。
  // 妆造库走 styleCache 的 5 分钟缓存，通常压根不发请求。
  async loadAll() {
    await Promise.all([this.loadCosmetics(), this.loadStyleNames()]);
  },

  async loadCosmetics(force) {
    if (!this.data.isAdmin) return;
    this.setData({ loading: true });
    try {
      const r = await cosmeticsCache.getCosmetics(force ? { maxAgeMs: 0 } : undefined);
      if (r && r.success) {
        this.setData({ list: r.cosmetics || [] });
        this.applyView();
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

  // 适用妆造的名字只从妆造库取（styleCache），不新建第二份妆造数据源。
  // 妆造改名后这里跟着变，旧化妆品文档里存的旧名字会自然从 activeStyles 里掉出去
  // （原始 styles 数组仍原样保留，改回来链接自动复原，不需要迁移）。
  async loadStyleNames() {
    try {
      const r = await styleCache.getStyles();
      if (r && r.success) {
        this.setData({ styleNames: (r.styles || []).map(s => s.name) }, () => this.applyView());
      }
    } catch (e) {
      console.warn('妆造库加载失败，适用妆造将不可选', e);
    }
  },

  // ============ 筛选 / 分组（全部本地计算，一次云调用都不发）============
  applyView() {
    const { list, category, style, keyword, onlyUnused, groupBy } = this.data;
    const kw = (keyword || '').trim().toLowerCase();
    const now = expiry.todayStr();
    const known = this.data.styleNames;

    const decorated = list.map(c => {
      const level = expiry.expiryLevel(c.expireDate, now);
      const left = expiry.daysLeft(c.expireDate, now);
      return {
        ...c,
        level,
        // 用完的条目整行灰掉并沉底
        out: !(Number(c.remain) > 0),
        levelText: LEVEL_TEXT[level],
        levelColor: LEVEL_COLOR[level],
        levelBg: LEVEL_BG[level],
        expiryText: c.expireDate
          ? `${c.expireDate}（${left < 0 ? `已过期 ${-left} 天` : `剩 ${left} 天`}）`
          : '无保期',
        // 与当前妆造库取交集：库里没有的名字不参与筛选、不产生分组
        activeStyles: (c.styles || []).filter(n => known.indexOf(n) >= 0),
        createTimeMs: c.createTime ? new Date(c.createTime).getTime() : 0,
      };
    });

    const hit = decorated.slice().sort(cmpCosmetics).filter(c => {
      if (onlyUnused && c.out) return false;
      if (category && c.category !== category) return false;
      if (style && (c.activeStyles || []).indexOf(style) < 0) return false;
      // 只搜名称/品牌/色号。刻意不搜备注——搜「备用」会把整架子埋掉
      if (kw && [c.name, c.brand, c.shade].join(' ').toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });

    // 分组发生在筛选**之后**，组头计数永远等于屏幕上的数量
    const groups = groupBy === 'none'
      ? [{ key: 'all', label: '全部', count: hit.length, items: hit }]
      : buildGroups(hit, groupBy);

    // 顶部概览统计的是**未筛选**的全库：它是库存健康度，不是结果条数
    const s = cosmeticsCache.summarize(list, now);
    this.setData({
      groups,
      visibleCount: hit.length,
      totalCount: s.total,
      expiredCount: s.expired,
      soonCount: s.soon,
      filterOn: Boolean(category || style || keyword || onlyUnused),
      styleChips: this.data.styleNames.map(n => ({ name: n, active: style === n })),
      formStyles: this.data.styleNames.map(n => ({ name: n, active: this.data.form.styles.indexOf(n) >= 0 })),
    });
  },

  // 妆造 chip 的选中态由 applyView 统一维护，不另开一处
  // （WXML 只能读 data、调不了方法，所以 filterOn 之类的开关也得落在 data 上）。

  // 每个 chip 在自己这一维内是单选：选种类不清妆造筛选，取交集才是化妆师预期的行为；
  // 再点一次当前 chip 就清空这一维。
  onCategoryChip(e) {
    const v = e.currentTarget.dataset.v || '';
    this.setData({ category: this.data.category === v ? '' : v }, () => this.applyView());
  },

  onStyleChip(e) {
    const v = e.currentTarget.dataset.v || '';
    this.setData({ style: this.data.style === v ? '' : v }, () => this.applyView());
  },

  onGroupBy(e) {
    this.setData({ groupBy: e.currentTarget.dataset.v || 'none' }, () => this.applyView());
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyView());
  },

  clearKeyword() {
    this.setData({ keyword: '' }, () => this.applyView());
  },

  toggleOnlyUnused() {
    this.setData({ onlyUnused: !this.data.onlyUnused }, () => this.applyView());
  },

  clearFilters() {
    this.setData({ category: '', style: '', keyword: '', onlyUnused: false }, () => this.applyView());
  },

  // ============ 表单 ============
  startAdd() {
    this.setData({ editingId: '', form: emptyForm(), formHint: '', categoryIndex: 0 });
    this.scrollToForm();
  },

  startEdit(e) {
    const id = e.currentTarget.dataset.id;
    const c = this.data.list.find(x => x._id === id);
    if (!c) return;
    const form = {
      ...emptyForm(),
      name: c.name || '',
      brand: c.brand || '',
      category: c.category || '',
      shade: c.shade || '',
      styles: (c.styles || []).slice(),
      produceDate: c.produceDate || '',
      shelfMonths: c.shelfMonths == null ? '' : String(c.shelfMonths),
      expireDate: c.expireDate || '',
      qty: String(c.qty || ''),
      remain: String(c.remain == null ? c.qty || '' : c.remain),
      photo: c.photo || '',
      note: c.note || '',
      // 已有到期日但没有生产日期 → 从「直接填到期日」模式进去更贴近实情
      expiryMode: c.produceDate ? 'produce' : 'expire',
    };
    // picker 的选中下标是 data 而不是方法——WXML 只能读 data，调不了 Page 上的方法
    const idx = this.data.categories.indexOf(c.category || '');
    this.setData({
      editingId: id,
      form,
      formHint: this.hintFor(form),
      categoryIndex: idx >= 0 ? idx : 0,
    }, () => this.scrollToForm());
  },

  cancelEdit() {
    this.setData({ editingId: '', form: emptyForm(), formHint: '', categoryIndex: 0 });
  },

  scrollToForm() {
    // 表单在页面底部，点「添加/编辑」滚过去，省得她以为按钮没生效
    setTimeout(() => {
      wx.pageScrollTo({ selector: '#formCard', duration: 200 });
    }, 60);
  },

  hintFor(form) {
    const r = expiry.resolveExpiry(form.produceDate, form.shelfMonths, form.expireDate);
    if (r.expireDate && form.expiryMode === 'produce') {
      return `由生产日期 + 保质期推得：到期日 ${r.expireDate}`;
    }
    if (r.expireDate && r.shelfMonths != null) {
      return `保质期约 ${r.shelfMonths} 个月，到期日 ${r.expireDate}`;
    }
    if (r.expireDate) return `到期日 ${r.expireDate}`;
    return '没有效期也可以保存，将显示为「无保期」';
  },

  refreshHint() {
    this.setData({ formHint: this.hintFor(this.data.form) });
  },

  onFormInput(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`form.${k}`]: e.detail.value }, () => this.refreshHint());
  },

  onExpiryMode(e) {
    this.setData({ 'form.expiryMode': e.currentTarget.dataset.v }, () => this.refreshHint());
  },

  onDateChange(e) {
    // <picker mode="date"> 只能用日期，放不下「保质期月数」，所以它单独用 number 输入
    const k = e.currentTarget.dataset.k;
    this.setData({ [`form.${k}`]: e.detail.value }, () => this.refreshHint());
  },

  onCategoryPick(e) {
    const i = e.detail.value;
    this.setData({ 'form.category': this.data.categories[i] || '', categoryIndex: i });
  },

  // 适用妆造多选。名字只取自妆造库，勾不存在的名字没有意义。
  toggleFormStyle(e) {
    const name = e.currentTarget.dataset.v;
    const cur = this.data.form.styles || [];
    const next = cur.indexOf(name) >= 0 ? cur.filter(n => n !== name) : cur.concat([name]);
    this.setData({
      'form.styles': next,
      formStyles: this.data.styleNames.map(n => ({ name: n, active: next.indexOf(n) >= 0 })),
    });
  },

  // ============ 照片 ============
  // 临时路径会被清理，选中后立即上传换 fileID，只留后者。
  async choosePhoto() {
    if (this.data.uploading) return;
    let tempPath = '';
    try {
      const chosen = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] });
      tempPath = chosen && chosen.tempFiles && chosen.tempFiles[0] && chosen.tempFiles[0].tempFilePath;
    } catch (e) {
      return; // 用户取消
    }
    if (!tempPath) return;

    this.setData({ uploading: true });
    try {
      const ext = (tempPath.match(/\.(\w+)$/) || [, 'jpg'])[1].toLowerCase();
      const cloudPath = `cosmetics/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
      this.setData({ 'form.photo': up.fileID });
    } catch (e) {
      console.error('化妆品照片上传失败', e);
      wx.showToast({ title: '照片上传失败', icon: 'none' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  removePhoto() {
    this.setData({ 'form.photo': '' });
  },

  // ============ 保存 ============
  async saveCosmetic() {
    const { form, editingId, saving } = this.data;
    if (saving) return;

    const name = (form.name || '').trim();
    if (!name) return wx.showToast({ title: '请输入化妆品名称', icon: 'none' });
    if (!form.category) return wx.showToast({ title: '请选择化妆品种类', icon: 'none' });

    const qty = Number(String(form.qty).trim());
    if (!String(form.qty).trim() || !isFinite(qty) || Math.floor(qty) !== qty || qty < 1) {
      return wx.showToast({ title: '请输入正确的数量', icon: 'none' });
    }
    const hasRemain = String(form.remain).trim() !== '';
    const remain = hasRemain ? Number(String(form.remain).trim()) : qty;
    if (hasRemain && (!isFinite(remain) || Math.floor(remain) !== remain || remain < 0 || remain > qty)) {
      return wx.showToast({ title: '剩余数量不能大于总数量', icon: 'none' });
    }

    const shelfRaw = String(form.shelfMonths).trim();

    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminCosmetics',
        data: {
          action: editingId ? 'update' : 'add',
          cosmeticId: editingId,
          name,
          brand: (form.brand || '').trim(),
          category: form.category,
          shade: (form.shade || '').trim(),
          styles: form.styles || [],
          produceDate: form.expiryMode === 'produce' ? (form.produceDate || '') : '',
          shelfMonths: form.expiryMode === 'produce' && shelfRaw ? Number(shelfRaw) : '',
          // 两种模式都把到期日原样送上去。生产日期+保质期齐全时云函数会自己重算并忽略它，
          // 少了生产日期时它才是唯一的信息来源——客户端送的只是一个值，云端始终是裁判。
          expireDate: form.expireDate || '',
          qty,
          remain,
          photo: form.photo || '',
          note: (form.note || '').trim(),
          token: getToken(),
        },
      });

      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message, icon: 'success' });
        this.setData({ editingId: '', form: emptyForm(), formHint: '', categoryIndex: 0 });
        this.patchLocal(res.result.cosmetic, editingId);
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

  // 本地打补丁，省掉紧随其后的那次全量 list（一次保存从 2 次调用降到 1 次）。
  // 云函数没回传 cosmetic（部署的还是旧版）时退回全量拉取，行为和以前完全一样。
  patchLocal(c, wasEditingId) {
    if (!c || !c._id) {
      this.loadCosmetics(true);
      return;
    }
    const next = wasEditingId
      ? this.data.list.map(x => (x._id === c._id ? { ...x, ...c } : x))
      : this.data.list.concat([c]);
    cosmeticsCache.saveCosmetics(next);
    this.setData({ list: next }, () => this.applyView());
  },

  // ============ 用掉一支 ============
  // 走云函数原子扣减（where({_id, remain: gt(0)}) + inc(-1)），
  // 不在本地减一：两位化妆师同时操作时本地各减一次，云端却只扣了一支。
  async consume(e) {
    const id = e.currentTarget.dataset.id;
    const c = this.data.list.find(x => x._id === id);
    if (!c) return;
    if (!(Number(c.remain) > 0)) {
      wx.showToast({ title: '这一件已经用完了', icon: 'none' });
      return;
    }

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminCosmetics',
        data: { action: 'consume', cosmeticId: id, token: getToken() },
      });
      if (res.result && res.result.success) {
        this.patchLocal(res.result.cosmetic, id);
      } else if (res.result && res.result.code === 'UNAUTHORIZED') {
        this.handleAuthFail();
      } else {
        showResult(res.result, '扣减失败');
        // 「已经用完了」说明本地那份是旧的（另一位化妆师刚扣过），拉一次纠正
        if (res.result && res.result.message === '这一件已经用完了') this.loadCosmetics(true);
      }
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '扣减失败', icon: 'none' });
    }
  },

  // ============ 删除 ============
  async deleteCosmetic(e) {
    const id = e.currentTarget.dataset.id;
    const c = this.data.list.find(x => x._id === id);
    if (!c) return;

    const r = await new Promise(resolve => {
      wx.showModal({
        title: '删除化妆品？',
        content: `将从化妆品库移除「${c.name}」。`,
        confirmColor: '#C95B7C',
        success: resolve,
        fail: resolve,
      });
    });
    if (!r || !r.confirm) return;

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminCosmetics',
        data: { action: 'delete', cosmeticId: id, token: getToken() },
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message, icon: 'success' });
        // 删掉的正好是正在编辑的那条，表单得跟着关掉，否则她会对着一条已不存在的东西改
        if (this.data.editingId === id) this.cancelEdit();
        const back = res.result.cosmetic;
        if (back && back._id === id) {
          this.patchLocalList(this.data.list.filter(x => x._id !== id));
        } else {
          this.loadCosmetics(true);
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

  patchLocalList(next) {
    cosmeticsCache.saveCosmetics(next);
    this.setData({ list: next }, () => this.applyView());
  },

  // 「操作说明」展开/收起。纯本地状态，不发任何云函数调用。
  toggleTips() {
    this.setData({ tipsExpanded: !this.data.tipsExpanded });
  },

  goBack() {
    wx.navigateBack();
  },
});
