const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// ============ 管理令牌校验（与 adminLogin 签发逻辑保持一致）============
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'makeup-miniprogram-token-secret-v1';

function verifyAdmin(event) {
  const token = event && event.token;
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  const given = Buffer.from(sig, 'utf8');
  const expectBuf = Buffer.from(expect, 'utf8');
  if (given.length !== expectBuf.length || !crypto.timingSafeEqual(given, expectBuf)) return false;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (e) {
    return false;
  }
  return !!data && typeof data.exp === 'number' && Date.now() <= data.exp;
}
// ================================================================

// 素颜照是云存储 fileID，直接丢给 <image> 会按“当前用户 openid”校验桶的 ACL，
// 桶若设为仅创建者可读写，化妆师就看不到顾客的照片（顾客自己却能看）。
// 云函数用 admin SDK 换临时链接绕过 ACL，桶的权限可以保持不变。
// 这是存储 API 调用，不消耗云函数调用次数；但只在化妆师点开“详细信息”时才走到，
// 且照片为空时直接短路，避免无谓请求。
async function toTempUrls(fileIDs) {
  if (!Array.isArray(fileIDs) || !fileIDs.length) return [];
  try {
    const res = await cloud.getTempFileURL({ fileList: fileIDs });
    const byId = {};
    (res.fileList || []).forEach((f) => {
      if (f && f.status === 0 && f.tempFileURL) byId[f.fileID] = f.tempFileURL;
    });
    // 按原顺序返回，单张失败只丢那一张，不影响其余展示
    return fileIDs.map((id) => byId[id]).filter(Boolean);
  } catch (err) {
    console.error('getTempFileURL error:', err);
    return [];
  }
}

// openid 形如 oXXXX...；挡掉明显不是 openid 的输入，避免被拿去拼查询
function isOpenid(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{10,64}$/.test(v);
}

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  const openid = event && event.openid;
  if (!isOpenid(openid)) {
    return { success: false, message: '缺少或无效的用户标识' };
  }

  try {
    const res = await db.collection('users').doc(openid).get();
    const doc = res.data || {};
    const info = doc.info || {};
    const photos = await toTempUrls(info.photos);
    return {
      success: true,
      exists: true,
      profile: {
        avatarUrl: doc.avatarUrl || '',
        nickname: doc.nickname || '',
      },
      info: {
        gender: info.gender || '',
        skinType: info.skinType || '',
        sensitiveLevel: info.sensitiveLevel || '',
        hasAcne: info.hasAcne || '',
        hasCosmeticSurgery: info.hasCosmeticSurgery || '',
        hasAllergy: info.hasAllergy || '',
        allergyNote: info.allergyNote || '',
        photos,
      },
      updateTime: doc.updateTime || null,
    };
  } catch (err) {
    const text = [err.errMsg, err.message].filter(Boolean).join(' | ');
    // 集合或文档不存在：不是错误，返回“该顾客还没填资料”
    if (/-502005|-502003/.test(text) || /not exist/i.test(text)) {
      return { success: true, exists: false, profile: { avatarUrl: '', nickname: '' }, info: null };
    }
    console.error('adminGetUserProfile error:', err);
    return { success: false, message: '读取顾客资料失败' };
  }
};