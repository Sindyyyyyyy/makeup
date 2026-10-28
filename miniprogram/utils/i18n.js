// utils/i18n.js - 顾客端界面的中英文切换
//
// 三个设计约束，改动前务必读完：
//
//   ① WXML 不能调用 JS 函数。所有文案必须先进 data 才能渲染，所以页面/组件把
//      整份字典放进 data.L，模板里写 {{L.index.someKey}}。
//
//   ② **存进数据库的枚举值本身就是中文**（性别 男/女、肤质 干性/油性/…、
//      过敏 有/无），云函数按值做白名单校验。改值等于改契约，所以这里只翻译
//      **显示标签**，存库的仍然是中文原值。label(kind, value) 干的正是这件事。
//      label 的映射表以中文原值为 key —— key 就是数据库里的值，拼错不可能发生。
//
//   ③ 语言切换**不引入订阅/发布机制**。语言只能在个人中心改，而个人中心是
//      tab 页，切回首页时 onShow 必然触发 → 那边重新读一次 getLang() 重渲染
//      即可。组件（info-form）通过 lang 属性接收，父页面 setData 后属性变更
//      即触发重渲染。
//
// 语言只落盘一次：setLang() 写 storage，自动检测的结果**不写** —— 于是
// 「用户没主动选过」时跟随微信系统语言，「主动选过」则以用户的选择为准。

const LANG_KEY = 'ui_lang';
const SUPPORTED = ['zh', 'en'];
const DEFAULT_LANG = 'zh';

const DICT = {
  zh: {
    common: {
      cancel: '取消',
      close: '关闭',
      save: '保存',
      saved: '已保存',
      updated: '已更新',
      loading: '加载中…',
      uploading: '上传中',
      loadFailed: '加载失败，请重试',
      saveFailed: '保存失败',
      saveFailedRetry: '保存失败，请重试',
      submitFailed: '提交失败',
      operationFailed: '操作失败',
      uploadFailed: '照片上传失败',
      ok: '知道了',
      // 缺项提示的前缀与分隔符：中文用「、」，英文用「, 」
      missing: '还差：',
      joiner: '、',
    },
    nav: {
      index: '我的化妆预约',
      profile: '个人中心',
    },
    tab: {
      index: '首页',
      profile: '个人中心',
    },
    // 星期几。数组下标与 computeWeekDates() 的 _idx（周一起）一一对应
    dow: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    // 时段名。key 与 SLOT_DEFS[].key 相同
    slot: { morning: '上午', afternoon: '下午', evening: '晚上' },
    // 预约状态。key 与后端 status 字段相同
    status: {
      pending: '待确认',
      confirmed: '已确认',
      cancelled: '已取消',
      rejected: '已拒绝',
      completed: '已完成',
    },
    // 规范中文值 → 显示标签。key 就是存进数据库的值，改这里不影响落库
    labels: {
      gender: { '男': '男', '女': '女' },
      skin: { '干性': '干性', '油性': '油性', '混合性': '混合性', '敏感性': '敏感性', '中性': '中性' },
      yesno: { '有': '有', '无': '无' },
      // missingFields() 返回的字段名（前后端各有一份，规则必须一致）
      field: {
        '昵称': '昵称',
        '性别': '性别',
        '肤质': '肤质',
        '敏感性程度': '敏感性程度',
        '大面积爆痘': '大面积爆痘',
        '整容/医美': '整容/医美',
        '化妆品/发品过敏': '化妆品/发品过敏',
        '过敏说明': '过敏说明',
        '素颜照': '素颜照',
      },
    },
    index: {
      title: '💄 预约化妆时间',
      subtitle: '胡鲁诺的化妆工作室 · 一对一专属服务',
      prevWeek: '◀ 上周',
      nextWeek: '下周 ▶',
      legendAvailable: '可约',
      legendLocked: '不可预约',
      legendTaken: '已占',
      legendMine: '我的',
      today: '今天',
      slotAvailable: '可约',
      slotMine: '我的',
      slotTaken: '已占',
      slotExpired: '已过时',
      slotPast: '🚫 时段已过',
      slotLocked: '🔒 暂未开放',
      myBookings: '我的预约',
      emptyBookings: '还没有预约哦，点击上方「可约」格子开始预约吧 🌸',
      labelNickname: '昵称：',
      labelStyle: '妆造：',
      labelRemark: '备注：',
      detail: '详细信息',
      cancelBooking: '取消预约',
      modalTitle: '预约',
      formNickname: '昵称',
      nicknameMissing: '未设置昵称，请先到个人中心填写',
      selectStyle: '选择妆造',
      noStyleYet: '该时段暂未设置妆造，提交后由化妆师与你确认',
      submitBooking: '提交预约',
      confirmTitle: '确认个人信息',
      detailTitle: '详细信息',
      confirmHint: '请确认信息已更新至最新，补全后才能提交预约',
      detailHint: '资料如有变化请及时更新',
      confirmSubmit: '确认并预约',
      saveSubmit: '保存',
      bookingSuccess: '预约成功',
      noticeSubtitle: '请留意以下化妆注意事项',
      noticeTip: '长按上方图片可保存到相册',
      noticeOk: '我知道了',
      nicknameRequired: '请先到个人中心设置昵称',
      styleRequired: '请选择要画的妆造',
      cannotSubmit: '无法提交预约',
      profileIncomplete: '请先补全个人信息',
      confirmCancelTitle: '确认取消？',
      confirmCancelContent: '取消后该时段将重新开放',
      cancelled: '已取消',
    },
    profile: {
      myProfile: '我的资料',
      nickname: '昵称',
      nicknamePlaceholder: '点击选择微信昵称',
      nicknameTip: '点头像换头像，点昵称用微信昵称',
      saveProfile: '保存资料',
      infoEntryTitle: '个人信息',
      infoEntrySub: '性别、肤质、爆痘、医美、过敏、素颜照',
      filled: '已填写',
      fill: '去填写',
      avatarUploadFailed: '头像上传失败',
      needAvatarOrNickname: '请先设置头像或昵称',
      allergyNoteHint: '建议写明过敏的具体产品',
      artistEntry: '🌷 化妆师入口',
      customerEntry: '💄 顾客端入口',
    },
    info: {
      title: '个人信息',
      nickname: '昵称',
      nicknameMissing: '未设置昵称，请到个人中心设置',
      gender: '性别',
      skinType: '肤质',
      sensitiveLevel: '敏感性程度',
      sensitiveLevelPlaceholder: '如：轻微泛红、刺痛',
      hasAcne: '大面积爆痘',
      hasCosmeticSurgery: '整容/医美',
      hasAllergy: '化妆品/发品过敏',
      allergyNote: '过敏说明',
      allergyNotePlaceholder: '如：对某款粉底液过敏',
      photos: '素颜照',
      photosOpen: '（',
      photosClose: '）',
      photoRequired: '至少上传 1 张素颜照才能预约',
      maxPhotos: '最多 {n} 张',
      uploadFailed: '照片上传失败',
      profileIncomplete: '请先补全个人信息',
    },
  },

  en: {
    common: {
      cancel: 'Cancel',
      close: 'Close',
      save: 'Save',
      saved: 'Saved',
      updated: 'Updated',
      loading: 'Loading…',
      uploading: 'Uploading',
      loadFailed: 'Load failed, retry',
      saveFailed: 'Save failed',
      saveFailedRetry: 'Save failed, retry',
      submitFailed: 'Submit failed',
      operationFailed: 'Action failed',
      uploadFailed: 'Photo upload failed',
      ok: 'Got it',
      missing: 'Missing: ',
      joiner: ', ',
    },
    nav: {
      index: 'My Makeup Booking',
      profile: 'Profile',
    },
    tab: {
      index: 'Home',
      profile: 'Profile',
    },
    dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    slot: { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' },
    status: {
      pending: 'Pending',
      confirmed: 'Confirmed',
      cancelled: 'Cancelled',
      rejected: 'Rejected',
      completed: 'Completed',
    },
    labels: {
      gender: { '男': 'Male', '女': 'Female' },
      skin: {
        '干性': 'Dry',
        '油性': 'Oily',
        '混合性': 'Combination',
        '敏感性': 'Sensitive',
        '中性': 'Normal',
      },
      yesno: { '有': 'Yes', '无': 'No' },
      field: {
        '昵称': 'Nickname',
        '性别': 'Gender',
        '肤质': 'Skin Type',
        '敏感性程度': 'Sensitivity',
        '大面积爆痘': 'Severe Acne',
        '整容/医美': 'Surgery',
        '化妆品/发品过敏': 'Product Allergy',
        '过敏说明': 'Allergy Details',
        '素颜照': 'Bare-face Photo',
      },
    },
    index: {
      title: '💄 Book a Makeup Session',
      subtitle: 'Hulunuo Makeup Studio · One-on-one Service',
      prevWeek: '◀ Prev',
      nextWeek: 'Next ▶',
      legendAvailable: 'Available',
      legendLocked: 'Closed',
      legendTaken: 'Booked',
      legendMine: 'Mine',
      today: 'Today',
      slotAvailable: 'Open',
      slotMine: 'Mine',
      slotTaken: 'Booked',
      slotExpired: 'Passed',
      slotPast: '🚫 Slot over',
      slotLocked: '🔒 Not open',
      myBookings: 'My Bookings',
      emptyBookings: 'No bookings yet. Tap an "Open" slot above to book 🌸',
      labelNickname: 'Name: ',
      labelStyle: 'Style: ',
      labelRemark: 'Note: ',
      detail: 'Details',
      cancelBooking: 'Cancel booking',
      modalTitle: 'Booking',
      formNickname: 'Name',
      nicknameMissing: 'No nickname yet — set it in Profile first',
      selectStyle: 'Choose a style',
      noStyleYet: 'No styles set for this slot yet; the artist will confirm with you',
      submitBooking: 'Book Now',
      confirmTitle: 'Confirm Your Details',
      detailTitle: 'Details',
      confirmHint: 'Please make sure your details are up to date — all fields are needed to book',
      detailHint: 'Please update your details if anything has changed',
      confirmSubmit: 'Confirm & Book',
      saveSubmit: 'Save',
      bookingSuccess: 'Booked!',
      noticeSubtitle: 'Please note the following makeup tips',
      noticeTip: 'Long-press the image to save it to your album',
      noticeOk: 'Got it',
      nicknameRequired: 'Set nickname in Profile first',
      styleRequired: 'Pick a makeup style',
      cannotSubmit: 'Cannot submit booking',
      profileIncomplete: 'Complete your profile first',
      confirmCancelTitle: 'Cancel this booking?',
      confirmCancelContent: 'This slot will reopen for others',
      cancelled: 'Cancelled',
    },
    profile: {
      myProfile: 'My Profile',
      nickname: 'Nickname',
      nicknamePlaceholder: 'Tap to pick a WeChat nickname',
      nicknameTip: 'Tap the avatar to change it; tap the name to use your WeChat nickname',
      saveProfile: 'Save Profile',
      infoEntryTitle: 'Personal Info',
      infoEntrySub: 'Gender, skin type, acne, surgery, allergies, bare-face photos',
      filled: 'Filled in',
      fill: 'Fill in',
      avatarUploadFailed: 'Avatar upload failed',
      needAvatarOrNickname: 'Set an avatar or nickname first',
      allergyNoteHint: 'Name the offending products',
      artistEntry: '🌷 Artist Entry',
      customerEntry: '💄 Customer View',
    },
    info: {
      title: 'Personal Info',
      nickname: 'Nickname',
      nicknameMissing: 'No nickname yet — set it in Profile',
      gender: 'Gender',
      skinType: 'Skin Type',
      sensitiveLevel: 'Sensitivity',
      sensitiveLevelPlaceholder: 'e.g. slight redness, stinging',
      hasAcne: 'Severe Acne',
      hasCosmeticSurgery: 'Cosmetic Surgery',
      hasAllergy: 'Product Allergy',
      allergyNote: 'Allergy Details',
      allergyNotePlaceholder: 'e.g. allergic to a certain foundation',
      photos: 'Bare-face Photos',
      photosOpen: ' (',
      photosClose: ')',
      photoRequired: 'Upload at least 1 bare-face photo to book',
      maxPhotos: 'Max {n} photos',
      uploadFailed: 'Photo upload failed',
      profileIncomplete: 'Complete your profile first',
    },
  },
};

// 自动检测结果只在本次会话里有效，不落盘
let detected = null;
let checked = false;

// 归一化：只认 'zh' / 'en'，其它一律中文
function normalize(lang) {
  return SUPPORTED.indexOf(lang) >= 0 ? lang : DEFAULT_LANG;
}

// 按微信设置的语言判断。注意这是**微信界面语言**，不是手机系统语言 ——
// getSystemInfoSync().language 没有基础库版本门槛，优先用它；
// getAppBaseInfo() 要 2.24.7+，基础库低时会不存在，所以必须先判断函数在不在。
// 非中英文一律回退中文：客群是中文用户，日文/韩文微信不该看到英文界面。
function detectLang() {
  if (detected) return detected;
  let raw = '';
  try {
    if (typeof wx.getAppBaseInfo === 'function') {
      const info = wx.getAppBaseInfo();
      raw = (info && info.language) || '';
    }
  } catch (e) { /* 取不到就换下面的方式 */ }
  if (!raw) {
    try {
      const info = wx.getSystemInfoSync();
      raw = (info && info.language) || '';
    } catch (e) { /* 忽略 */ }
  }
  detected = /^en/i.test(raw) ? 'en' : DEFAULT_LANG;
  return detected;
}

// 当前语言。用户显式选过就用用户的，否则跟随系统
function getLang() {
  const saved = wx.getStorageSync(LANG_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  return detectLang();
}

// 切换语言：归一化后落盘。**只有这里写 storage**
function setLang(lang) {
  const next = normalize(lang);
  wx.setStorageSync(LANG_KEY, next);
  return next;
}

// 按点路径取值，'index.title' → dict.index.title
function lookup(dict, key) {
  const parts = String(key || '').split('.');
  let cur = dict;
  for (let i = 0; i < parts.length; i += 1) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

// 取文案。en 缺词时回退中文，**绝不把原始 key 漏到界面上**
function t(key, vars) {
  return tIn(getLang(), key, vars);
}

// 指定语言取文案。组件用这个：后台两个宿主给 info-form 传 lang='zh'，
// 即便全局语言是英文，那个只读弹窗也必须是中文。
function tIn(lang, key, vars) {
  let s = lookup(DICT[normalize(lang)], key);
  if (typeof s !== 'string') s = lookup(DICT[DEFAULT_LANG], key);
  if (typeof s !== 'string') {
    console.warn('[i18n] 缺少文案：', key);
    return key;
  }
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (
      vars[name] === undefined || vars[name] === null ? m : String(vars[name])
    ));
  }
  return s;
}

// 规范中文值 → 当前语言的显示标签。
// kind: 'gender' | 'skin' | 'yesno' | 'field'
// 找不到就原样返回（中文值本身就是可读的兜底）
function label(kind, value) {
  return labelIn(getLang(), kind, value);
}

// 指定语言取标签。理由同 tIn()：组件可能被要求固定用某一种语言渲染。
function labelIn(lang, kind, value) {
  if (!value) return value;
  const map = lookup(DICT[normalize(lang)], 'labels.' + kind);
  if (map && map[value] !== undefined) return map[value];
  const zhMap = lookup(DICT[DEFAULT_LANG], 'labels.' + kind);
  return zhMap && zhMap[value] !== undefined ? zhMap[value] : value;
}

// 按当前语言拼接一组标签（中文「、」，英文「, 」）
function listJoin(arr) {
  return listJoinIn(getLang(), arr);
}

// 指定语言拼接标签
function listJoinIn(lang, arr) {
  const l = normalize(lang);
  const list = (arr || []).map(x => labelIn(l, 'field', x));
  const sep = lookup(DICT[l], 'common.joiner') || '、';
  return list.join(sep);
}

// 整份字典（默认当前语言）。放进 data.L 供 WXML 取用
function getDict(lang) {
  const key = lang ? normalize(lang) : getLang();
  ensureDictChecked();
  return DICT[key];
}

// 启动期自检：zh 字典是完整的基准，en 少了哪个词条就警告一次。
// 这样「en 缺词会静默回退中文」这件事在开发期就暴露出来，而不是上线后才发现。
function ensureDictChecked() {
  if (checked) return;
  checked = true;
  const missing = [];
  (function walk(zh, en, path) {
    if (typeof zh === 'string') {
      if (typeof en !== 'string') missing.push(path);
      return;
    }
    if (!zh || typeof zh !== 'object') return;
    Object.keys(zh).forEach((k) => {
      walk(zh[k], en && en[k] ? en[k] : undefined, path ? path + '.' + k : k);
    });
  })(DICT.zh, DICT.en, '');
  if (missing.length) {
    console.warn('[i18n] en 缺少以下文案（会回退中文）：', missing.join(', '));
  }
}

module.exports = {
  LANG_KEY,
  SUPPORTED,
  DEFAULT_LANG,
  detectLang,
  getLang,
  setLang,
  getDict,
  t,
  tIn,
  label,
  labelIn,
  listJoin,
  listJoinIn,
};
