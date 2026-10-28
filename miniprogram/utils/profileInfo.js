// utils/profileInfo.js - 个人信息表的字段定义与完整性校验
// 前端（组件 / 页面）与云端 createBooking 各自持有一份同样的规则，
// 这里是前端的唯一来源；云端那份在 cloudfunctions/createBooking/index.js，改动需同步。

const MAX_PHOTOS = 5;
const MIN_PHOTOS_FOR_BOOKING = 1;

// 想画的妆容照片：属于**单次预约**，不属于个人资料。
// 顾客每次想画的妆容大概率不同，所以每下一单都要重新传，图存 bookings 上。
// ⚠️ 它**不能**进 emptyForm() —— emptyForm() 的键集合同时是 sameForm() 的比较范围
// 和 users.info 的形状，进了它就会混进个人资料。
const MAX_STYLE_REF_PHOTOS = 3;

const GENDER_OPTIONS = ['男', '女'];
const SKIN_OPTIONS = ['干性', '油性', '混合性', '敏感性', '中性'];
const YES_NO_OPTIONS = ['有', '无'];

function emptyForm() {
  return {
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
}

// 与 info 合并，返回完整表单；nickname 永远以页面传入的为准（同一个 users.nickname 字段）
function toForm(info, nickname) {
  const src = info || {};
  return {
    ...emptyForm(),
    ...src,
    nickname: nickname === undefined ? (src.nickname || '') : nickname,
    photos: Array.isArray(src.photos) ? src.photos.slice() : [],
  };
}

// 返回缺失项的字段名数组，空数组 = 完整
// opts.requirePhoto：素颜照是否也算必填（预约时算，单纯填资料时不算）
function missingFields(info, opts) {
  const options = opts || {};
  const f = toForm(info);
  const missing = [];
  if (!f.nickname) missing.push('昵称');
  if (!f.gender) missing.push('性别');
  if (!f.skinType) missing.push('肤质');
  // 条件必填：选了敏感性就必须写程度
  if (f.skinType === '敏感性' && !f.sensitiveLevel) missing.push('敏感性程度');
  if (!f.hasAcne) missing.push('大面积爆痘');
  if (!f.hasCosmeticSurgery) missing.push('整容/医美');
  if (!f.hasAllergy) missing.push('化妆品/发品过敏');
  // 条件必填：过敏选了“有”就得写清楚是什么
  if (f.hasAllergy === '有' && !f.allergyNote) missing.push('过敏说明');
  if (options.requirePhoto && f.photos.length < MIN_PHOTOS_FOR_BOOKING) missing.push('素颜照');
  return missing;
}

function isComplete(info, opts) {
  return missingFields(info, opts).length === 0;
}

// 两份表单是否逐字段相同（含 photos 数组，按顺序比较）。
// 用途：预约前的「确认资料」弹窗里，顾客经常什么都不改就点提交，
// 那时不必再发一次 userProfile saveInfo —— 云函数调用次数是稀缺的资源。
// 只比 emptyForm() 的键集合：info 里可能混入 nickname 之类不该参与比较的字段，
// 多比一个字段就可能让本该跳过的写入重新发生。
function sameForm(a, b) {
  const x = toForm(a);
  const y = toForm(b);
  const keys = Object.keys(emptyForm());
  for (const k of keys) {
    if (k === 'photos') {
      const pa = x.photos || [];
      const pb = y.photos || [];
      if (pa.length !== pb.length) return false;
      for (let i = 0; i < pa.length; i++) {
        if (pa[i] !== pb[i]) return false;
      }
      continue;
    }
    if (String(x[k] || '').trim() !== String(y[k] || '').trim()) return false;
  }
  return true;
}

// 两个字符串数组是否逐项相同（顺序也要一样）。
// 用途：「想画的妆容照片」在顾客改完之后判断有没有动过——没动就别发云函数请求，
// 云开发免费版每月仅 20 万次调用额度，不该为「没改」付费。
function sameList(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

// 「资料上次从云端拉取的时间」放在 storage，而不是页面实例字段上。
// 首页和个人中心是两个 tab 页，各有各的实例字段、互相看不见：原来两边各发一次
// userProfile{action:'get'}，拿回来的还是同一份数据。共用一个时间戳后，
// 60 秒内第二个 tab 打开就只读 storage 缓存（两边的 onLoad 都已经渲染过它了）。
const FETCHED_AT_KEY = 'profile_fetched_at';

function fetchedAt() {
  return wx.getStorageSync(FETCHED_AT_KEY) || 0;
}

function markFetched() {
  wx.setStorageSync(FETCHED_AT_KEY, Date.now());
}

// 保存资料后必须清零，否则下一次打开看到的是刚被自己覆盖掉的旧值
function clearFetched() {
  wx.removeStorageSync(FETCHED_AT_KEY);
}

module.exports = {
  MAX_PHOTOS,
  MIN_PHOTOS_FOR_BOOKING,
  MAX_STYLE_REF_PHOTOS,
  GENDER_OPTIONS,
  SKIN_OPTIONS,
  YES_NO_OPTIONS,
  emptyForm,
  toForm,
  missingFields,
  isComplete,
  sameForm,
  sameList,
  fetchedAt,
  markFetched,
  clearFetched,
};