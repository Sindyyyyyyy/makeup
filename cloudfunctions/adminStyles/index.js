const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 妆造库集合：每个文档一个妆造 { name, price, sort }
const COLLECTION = 'styles';

const MAX_NAME = 20;
const MAX_PRICE = 99999;
const MAX_COUNT = 30;

// 首次使用时的默认妆造，保证「妆容管理」一打开就有内容
const DEFAULTS = [
  { name: '新娘妆', price: 100 },
  { name: '日系妆', price: 200 },
  { name: '韩系妆', price: 300 },
];

// ============ 管理令牌校验（与 adminLogin 签发逻辑保持一致）============
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'makeup-miniprogram-token-secret-v1';

function verifyAdmin(event, context) {
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

function parseStyle(name, price) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { error: '妆造名称不能为空' };
  if (cleanName.length > MAX_NAME) return { error: `妆造名称不能超过 ${MAX_NAME} 个字` };
  const p = typeof price === 'number' ? price : Number(String(price == null ? '' : price).trim());
  if (!isFinite(p) || isNaN(p)) return { error: `妆造「${cleanName}」的价格无效` };
  if (p < 0) return { error: `妆造「${cleanName}」的价格不能为负` };
  if (p > MAX_PRICE) return { error: `妆造「${cleanName}」的价格不能超过 ${MAX_PRICE} 元` };
  return { style: { name: cleanName, price: Math.round(p * 100) / 100 } };
}

// 集合不存在时云函数无权自动创建（需在云开发控制台手工新建），
// 这里把它翻译成一句能照做的提示，避免用户看到 -502005 原始报错
function isCollectionMissing(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  return msg.includes('-502005') || msg.includes('collection not exists');
}

const COLLECTION_MISSING_MSG =
  '数据库集合 styles 不存在，请打开云开发控制台 → 数据库 → 新建集合，集合名填 styles，然后重新部署本云函数。';

// 按 sort、_id 稳定排序返回
async function listStyles() {
  let res;
  try {
    res = await db.collection(COLLECTION).orderBy('sort', 'asc').get();
  } catch (err) {
    if (isCollectionMissing(err)) throw new Error(COLLECTION_MISSING_MSG);
    throw err;
  }

  // 首次使用：写入默认妆造，避免化妆师面对空白页
  if (!res.data || res.data.length === 0) {
    for (let i = 0; i < DEFAULTS.length; i++) {
      await db.collection(COLLECTION).add({
        data: { ...DEFAULTS[i], sort: i, createTime: db.serverDate() },
      });
    }
    const seeded = await db.collection(COLLECTION).orderBy('sort', 'asc').get();
    return seeded.data;
  }
  return res.data;
}

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  const { action } = event;
  if (!action) return { success: false, message: '参数不完整' };

  try {
    if (action === 'list') {
      return { success: true, styles: await listStyles() };
    }

    if (action === 'add') {
      const parsed = parseStyle(event.name, event.price);
      if (parsed.error) return { success: false, message: parsed.error };

      const existing = await db.collection(COLLECTION).where({ name: parsed.style.name }).limit(1).get();
      if (existing.data && existing.data.length > 0) {
        return { success: false, message: `妆造「${parsed.style.name}」已存在` };
      }

      const countRes = await db.collection(COLLECTION).count();
      if (countRes.total >= MAX_COUNT) {
        return { success: false, message: `妆造最多 ${MAX_COUNT} 个` };
      }

      await db.collection(COLLECTION).add({
        data: { ...parsed.style, sort: countRes.total, createTime: db.serverDate() },
      });
      return { success: true, message: '已添加妆造' };
    }

    if (action === 'update') {
      const { styleId } = event;
      if (!styleId) return { success: false, message: '参数不完整' };
      const parsed = parseStyle(event.name, event.price);
      if (parsed.error) return { success: false, message: parsed.error };

      const dup = await db.collection(COLLECTION).where({ name: parsed.style.name }).limit(1).get();
      if (dup.data.some(d => d._id !== styleId)) {
        return { success: false, message: `妆造「${parsed.style.name}」已存在` };
      }

      const res = await db.collection(COLLECTION).doc(styleId).update({ data: parsed.style });
      if (res.stats.updated !== 1) return { success: false, message: '妆造不存在' };
      return { success: true, message: '已保存修改' };
    }

    if (action === 'delete') {
      const { styleId } = event;
      if (!styleId) return { success: false, message: '参数不完整' };
      const res = await db.collection(COLLECTION).doc(styleId).remove();
      // 注意：云开发 doc().remove() 返回的计数是 stats.removed（不是 deleted）
      const removed = (res.stats && (res.stats.removed != null ? res.stats.removed : res.stats.deleted)) || 0;
      if (removed !== 1) return { success: false, message: '妆造不存在' };
      return { success: true, message: '已删除妆造' };
    }

    return { success: false, message: '无效操作' };
  } catch (err) {
    console.error('adminStyles error:', err);
    const message = isCollectionMissing(err) ? COLLECTION_MISSING_MSG : '服务器错误：' + err.message;
    return { success: false, message };
  }
};
