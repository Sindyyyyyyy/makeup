// utils/profileInfo.js - 个人信息表的字段定义与完整性校验
// 前端（组件 / 页面）与云端 createBooking 各自持有一份同样的规则，
// 这里是前端的唯一来源；云端那份在 cloudfunctions/createBooking/index.js，改动需同步。

const MAX_PHOTOS = 5;
const MIN_PHOTOS_FOR_BOOKING = 1;

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

module.exports = {
  MAX_PHOTOS,
  MIN_PHOTOS_FOR_BOOKING,
  GENDER_OPTIONS,
  SKIN_OPTIONS,
  YES_NO_OPTIONS,
  emptyForm,
  toForm,
  missingFields,
  isComplete,
};