const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTION = 'users';
const MAX_NICKNAME = 20;
const MAX_PHOTOS = 5;
const MAX_ALLERGY_NOTE = 100;
const MAX_SENSITIVE_LEVEL = 50;

// 枚举一律白名单校验，客户端传什么都不直接落库
const GENDERS = ['男', '女'];
const SKIN_TYPES = ['干性', '油性', '混合性', '敏感性', '中性'];
const YES_NO = ['有', '无'];
// 选填项：客户端没传就保持原值，传了才校验
function pickEnum(value, allowed, fallback) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!v) return fallback === undefined ? '' : fallback;
  return allowed.indexOf(v) >= 0 ? v : '';
}

// 身份只认服务端 OPENID，绝不从 event 取
function getOpenid(context) {
  let openid = null;
  try {
    const wxCtx = cloud.getWXContext();
    openid = (wxCtx && wxCtx.OPENID) || null;
  } catch (e) {
    openid = null;
  }
  if (!openid && context) openid = context.OPENID || null;
  return openid;
}

// 云函数拿到的错误对象形状不固定：有的是 {errCode, errMsg}，
// 有的只是普通 Error（只有 message/stack）。统一把所有文本拼起来再判断。
function errText(err) {
  if (!err) return '';
  return [err.errMsg, err.message, err.stack].filter(Boolean).join(' | ');
}

// 集合不存在：-502005，或文案里出现 collection.users / collection not exist
function isMissingCollection(err) {
  const text = errText(err);
  if (err && err.errCode === -502005) return true;
  if (!text) return false;
  if (/collection[\s.]*not[\s.]*exist|collection.*does not exist|-502005/i.test(text)) return true;
  // 形如 "collection.users is not exist"：集合名 + 缺失表述
  return new RegExp(`collection\\.?${COLLECTION}\\b.*(not|non).*exist`, 'i').test(text);
}

// 单个文档读不到（集合存在但该 openid 还没有记录）
function isMissingDoc(err) {
  const text = errText(err);
  if (err && err.errCode === -502003) return true;
  return /document.*(not|no).*exist|-502003/i.test(text);
}

function normalize(input) {
  return {
    avatarUrl: String(input.avatarUrl || '').trim(),
    nickname: String(input.nickname || '').trim().slice(0, MAX_NICKNAME),
  };
}

// 素颜照：只保留云存储 fileID，最多 MAX_PHOTOS 张
function normalizePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p) => String(p || '').trim())
    .filter((p) => p.indexOf('cloud://') === 0 || /^https?:\/\//.test(p))
    .slice(0, MAX_PHOTOS);
}

// 表单结构（素颜照选填，其余选填但会覆盖）
function normalizeInfo(input, prev) {
  const src = input || {};
  const oldInfo = prev || {};
  const skinType = pickEnum(src.skinType, SKIN_TYPES, oldInfo.skinType);
  // 敏感性程度只在肤质=敏感性时才有意义，换成别的肤质就清掉，
  // 免得留下过期的自由文本
  const rawSensitive = src.sensitiveLevel === undefined
    ? (oldInfo.sensitiveLevel || '')
    : (src.sensitiveLevel || '');
  return {
    gender: pickEnum(src.gender, GENDERS, oldInfo.gender),
    skinType,
    sensitiveLevel: skinType === '敏感性'
      ? String(rawSensitive).trim().slice(0, MAX_SENSITIVE_LEVEL)
      : '',
    hasAcne: pickEnum(src.hasAcne, YES_NO, oldInfo.hasAcne),
    hasCosmeticSurgery: pickEnum(src.hasCosmeticSurgery, YES_NO, oldInfo.hasCosmeticSurgery),
    hasAllergy: pickEnum(src.hasAllergy, YES_NO, oldInfo.hasAllergy),
    allergyNote: String(
      src.allergyNote === undefined ? (oldInfo.allergyNote || '') : src.allergyNote || ''
    ).trim().slice(0, MAX_ALLERGY_NOTE),
    photos: src.photos === undefined ? (oldInfo.photos || []) : normalizePhotos(src.photos),
  };
}

// 表单是否有实际内容（用来在页面上显示“已填写/未填写”）
function hasInfo(info) {
  if (!info) return false;
  return Boolean(info.gender || info.skinType || info.sensitiveLevel || info.hasAcne
    || info.hasCosmeticSurgery || info.hasAllergy || (info.photos && info.photos.length));
}

// 读取本人文档；集合不存在 / 文档不存在时给出可区分的标记
async function readDoc(openid) {
  try {
    const res = await db.collection(COLLECTION).doc(openid).get();
    return { doc: res.data || {}, exists: true };
  } catch (err) {
    if (isMissingCollection(err)) {
      return { missingCollection: true, exists: false };
    }
    if (isMissingDoc(err)) {
      return { doc: {}, exists: false };
    }
    throw err;
  }
}

exports.main = async (event, context) => {
  const openid = getOpenid(context);
  if (!openid) {
    return { code: 'NO_OPENID', success: false, message: '未取到用户身份' };
  }

  const action = (event && event.action) || 'get';

  try {
    // 表单与头部资料分开写：两个按钮互不覆盖对方的字段
    if (action === 'saveInfo') {
      const { doc, exists, missingCollection } = await readDoc(openid);
      if (missingCollection) {
        return { success: false, code: 'NO_COLLECTION', message: `云数据库缺少 ${COLLECTION} 集合，请先在控制台创建` };
      }
      const info = normalizeInfo(event.info, doc.info);
      const patch = { info, updateTime: db.serverDate() };
      // 昵称共用一个字段：表里改了昵称，顶部也跟着变
      if (event.nickname !== undefined) {
        patch.nickname = String(event.nickname || '').trim().slice(0, MAX_NICKNAME);
      }
      const ref = db.collection(COLLECTION).doc(openid);
      // 云函数侧 update/set 都要 { data: {...} } 包装，直接传字段会报
      // "parameter.data should be object instead of undefined"
      if (exists) {
        await ref.update({ data: patch });
      } else {
        // 还没保存过头像资料时文档不存在，update 会失败，退回 set 建档
        await ref.set({ data: { _openid: openid, avatarUrl: '', nickname: '', ...patch } });
      }
      return {
        success: true,
        info,
        nickname: patch.nickname === undefined ? (doc.nickname || '') : patch.nickname,
        hasInfo: hasInfo(info),
      };
    }

    if (action === 'save') {
      const profile = normalize(event);
      if (!profile.avatarUrl && !profile.nickname) {
        return { success: false, message: '头像和昵称不能同时为空' };
      }
      // 注意：set() 会整体替换文档，会把 info 表单内容冲掉。
      // 所以文档已存在时必须用 update() 只改这两个字段。
      const { doc, exists, missingCollection } = await readDoc(openid);
      if (missingCollection) {
        return { success: false, code: 'NO_COLLECTION', message: `云数据库缺少 ${COLLECTION} 集合，请先在控制台创建` };
      }
      const patch = { ...profile, updateTime: db.serverDate() };
      const ref = db.collection(COLLECTION).doc(openid);
      // 云函数侧 update/set 都要 { data: {...} } 包装，直接传字段会报
      // "parameter.data should be object instead of undefined"
      if (exists) {
        await ref.update({ data: patch });
      } else {
        await ref.set({ data: { _openid: openid, ...patch } });
      }
      return { success: true, profile, hasInfo: hasInfo(normalizeInfo(undefined, doc.info)) };
    }

    // 默认：读取
    const { doc, exists, missingCollection } = await readDoc(openid);
    if (missingCollection) {
      return { success: false, code: 'NO_COLLECTION', message: `云数据库缺少 ${COLLECTION} 集合，请先在控制台创建` };
    }
    const info = normalizeInfo(undefined, doc.info);
    return {
      success: true,
      exists,
      profile: {
        avatarUrl: doc.avatarUrl || '',
        nickname: doc.nickname || '',
        updateTime: doc.updateTime || null,
      },
      info,
      hasInfo: hasInfo(info),
    };
  } catch (err) {
    console.error('userProfile error:', errText(err) || err);
    const missing = isMissingCollection(err);
    return {
      success: false,
      code: missing ? 'NO_COLLECTION' : 'SERVER_ERROR',
      message: missing
        ? `云数据库缺少 ${COLLECTION} 集合，请先在控制台创建`
        : '服务异常，请重试',
      // 原样带回，方便在控制台/页面 console 里定位，不必猜
      detail: errText(err) || String(err),
      errCode: (err && err.errCode) || null,
    };
  }
};