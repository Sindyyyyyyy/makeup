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

const SLOT_KEYS = ['morning', 'afternoon', 'evening'];

// 时段入口（date + slot）：时段管理页只知道「这天这个时段被预约了」，
// 顾客 openid 只存在 bookings 里。与其让客户端先查 bookings 再带着 openid
// 调一次（两次云函数调用），不如在这里一次查完——云函数调用次数是稀缺的。
// 注意 .where({ date }) 是单字段查询：date+slot 的组合查询可能要求额外索引，
// 所以 slot 的过滤放在内存里做。
async function findBooking(date, slot) {
  // 上限只是防呆。理论上一天最多 3 条有效预约（三个时段各一），
  // 但历史数据里可能留下已取消/已拒绝的脏记录，所以给到 500 再在内存里筛。
  // 上限太低会「静默查不到」——下面返回 exists:false，页面会显示成
  // 「没有对应的预约记录」，看着像没预约，其实是被 limit 截掉了。
  const res = await db.collection('bookings').where({ date }).limit(500).get();
  return (res.data || []).find(
    (b) => b.slot === slot && b.status !== 'rejected' && b.status !== 'cancelled'
  ) || null;
}

// 读顾客资料：两个入口共用，返回结构一字不变
async function readUserProfile(openid) {
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
    // 集合或文档不存在：不是错误，返回"该顾客还没填资料"
    if (/-502005|-502003/.test(text) || /not exist/i.test(text)) {
      return { success: true, exists: false, profile: { avatarUrl: '', nickname: '' }, info: null };
    }
    throw err;
  }
}

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  const date = event && event.date;
  const slot = event && event.slot;

  try {
    // 入口二：按日期 + 时段找人（时段管理页用），openid 由服务端自己解析
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && SLOT_KEYS.indexOf(slot) >= 0) {
      const hit = await findBooking(date, slot);
      if (!hit) {
        // 不是错误：可能只是历史脏数据（时段被占了但预约记录没了）
        return { success: true, exists: false, booking: null, profile: null, info: null };
      }
      const res = await readUserProfile(hit._openid);
      // 不回传 _openid：客户端拿到资料就够了，openid 是顾客身份，没必要外流
      return Object.assign({}, res, {
        booking: {
          name: hit.name || '',
          styleName: hit.styleName || '',
          status: hit.status || '',
          date: hit.date || date,
          slot: hit.slot || slot,
        },
      });
    }

    // 入口一：直接按 openid 查（化妆师后台首页的预约卡片用）
    const openid = event && event.openid;
    if (!isOpenid(openid)) {
      return { success: false, message: '缺少或无效的用户标识' };
    }
    return await readUserProfile(openid);
  } catch (err) {
    console.error('adminGetUserProfile error:', err);
    return { success: false, message: '读取顾客资料失败' };
  }
};