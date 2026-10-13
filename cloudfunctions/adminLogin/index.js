const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTION = 'users';
// 管理密码与令牌密钥仅存在于服务端（云函数代码不会打进小程序包）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'makeup2026';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'makeup-miniprogram-token-secret-v1';
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

function sign(payload) {
  return require('crypto').createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
}

// 身份只认服务端 OPENID，绝不从 event 取。与 userProfile / createBooking 同一套写法，
// 按本仓库约定每个云函数各抄一份，不共享模块。
// （早先这里注释说"未登录的云函数调用拿不到 OPENID"，那是错的：userProfile 正是
//   靠 cloud.getWXContext() 建的用户文档。）
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

// 云函数拿到的错误对象形状不固定：有的 {errCode, errMsg}，有的只是普通 Error
function errText(err) {
  if (!err) return '';
  return [err.errMsg, err.message, err.stack].filter(Boolean).join(' | ');
}
// users 集合要手动在控制台建，可能根本不存在
function isMissingCollection(err) {
  const text = errText(err);
  if (err && err.errCode === -502005) return true;
  return /collection[\s.]*not[\s.]*exist|collection.*does not exist|-502005/i.test(text);
}
// 文档不存在：化妆师可能从没打开过个人中心
function isMissingDoc(err) {
  const text = errText(err);
  if (err && err.errCode === -502003) return true;
  return /document.*(not|no).*exist|-502003/i.test(text);
}

// 令牌格式和签发逻辑与改动前完全一致（载荷只有 {exp}，不绑定 openid）。
// 本次只加"免密重签"，不动签名协议——各 admin* 函数的 verifyAdmin 保持原样。
function mint() {
  const exp = Date.now() + TOKEN_TTL;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64');
  return { exp, token: `${payload}.${sign(payload)}` };
}

// 写 users.admin。
// 文档已存在 → update（绝不能用 set，会整体替换文档、冲掉 info/昵称/头像，
//   见 userProfile 里"set() 会把 info 表单内容冲掉"的警告）。
// 文档不存在 → 这时才用 set 建档；此时文档里本来就没有任何资料，冲不掉什么。
async function setAdminFlag(openid, value) {
  const ref = db.collection(COLLECTION).doc(openid);
  const patch = { admin: value, adminUpdateTime: db.serverDate() };
  try {
    await ref.update({ data: patch });
  } catch (err) {
    if (!isMissingDoc(err)) throw err;
    // 首次建档，只写身份字段，avatarUrl/nickname 留空等本人去个人中心填
    await ref.set({ data: { _openid: openid, avatarUrl: '', nickname: '', ...patch } });
  }
}

// 免密重签：只认服务端 users.admin，不认客户端带来的任何东西。
async function handleRefresh(context) {
  const openid = getOpenid(context);
  if (!openid) {
    return { success: false, code: 'NO_OPENID', message: '未取到用户身份，请输管理密码' };
  }

  let doc = {};
  try {
    const res = await db.collection(COLLECTION).doc(openid).get();
    doc = res.data || {};
  } catch (err) {
    // 集合没建：等价于"不是化妆师"，让前端退回密码框
    if (isMissingCollection(err)) {
      return { success: false, code: 'NO_COLLECTION', message: '云数据库缺少 users 集合，请先在控制台创建' };
    }
    if (!isMissingDoc(err)) throw err;
    doc = {}; // 集合在、文档不在 → 不是化妆师
  }

  // 严格布尔：字段缺失、字符串 "true"、1 都不算数
  if (doc.admin !== true) {
    return { success: false, code: 'NOT_ADMIN', message: '需要重新验证管理密码' };
  }

  const { token, exp } = mint();
  return { success: true, token, expiresAt: exp };
}

exports.main = async (event, context) => {
  try {
    // 只有精确的 'refresh' 才走免密。缺失或乱写的 action 一律降级为要密码，
    // 绝不能降级到免密通道。
    if (event && event.action === 'refresh') return await handleRefresh(context);

    // ===== 密码分支 =====
    // 密码错就地结束：不写 admin、不发令牌，也不会 fall through 到 refresh。
    if (!event || event.password !== ADMIN_PASSWORD) {
      return { success: false, code: 'BAD_PASSWORD', message: '权限验证失败' };
    }

    const { token, exp } = mint();

    // 密码正确 → 记住"这个人是化妆师"，以后可免密重签。
    // 写入失败不阻断本次登录（各 admin* 函数并不读 users），但要如实回报，
    // 否则"users 集合没建"会变成一个查不出原因的怪问题。
    const openid = getOpenid(context);
    let adminBound = false;
    if (openid) {
      try {
        await setAdminFlag(openid, true);
        adminBound = true;
      } catch (err) {
        console.error('adminLogin: 写入 users.admin 失败', errText(err) || err);
      }
    } else {
      console.warn('adminLogin: 未取到 openid，本次无法绑定化妆师身份');
    }

    return { success: true, token, expiresAt: exp, adminBound };
  } catch (err) {
    console.error('adminLogin error:', errText(err) || err);
    return { success: false, code: 'SERVER_ERROR', message: '服务器错误：' + err.message };
  }
};