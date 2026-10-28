const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 化妆品库集合：每个文档一支化妆品
// 多个化妆师共用这一份清单，所以不带 _openid 之类的归属字段——
// 和「妆造库 styles」一样是工作室公用的资产，而不是谁的私人抽屉。
const COLLECTION = 'cosmetics';

const MAX_NAME = 30;
const MAX_BRAND = 20;
const MAX_SHADE = 20;
const MAX_NOTE = 100;
const MAX_STYLES = 30;
const MAX_QTY = 9999;
const MAX_SHELF = 240;

// 云数据库单次 .get() 最多返回 100 条，list 在云函数内部翻页取完
const PAGE_SIZE = 100;
// 集合硬上限。实际用量 150~300 条（5 品牌 × 口红 8 支 + 粉底 10 + 粉饼眼影盘 20 …），
// 500 条约 200KB，远低于 1MB 响应上限。函数内部读不计费（只有调用次数计费），
// 所以这里翻几页都不额外花钱。
const MAX_TOTAL = 500;

// 种类枚举。刻意不给自由输入：拼错一个「口紅」就会多出一个筛选项，
// 把分组打碎。前端 utils/expiry.js 之外各存一份（不共享模块，见文件末尾约定）。
const CATEGORIES = [
  '口红', '粉底', '粉饼', '遮瑕', '定妆粉', '腮红', '眉笔',
  '眼线笔', '眼影', '睫毛膏', '定妆喷雾', '卸妆', '其他',
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

// ---- 日期工具 ----
// 与 miniprogram/utils/expiry.js 保持同一套算法。
// 按仓库约定每个云函数各抄一份，不跨 miniprogram/ 与 cloudfunctions/ 共享模块
// （两个目录不在彼此的文件系统里）。

function parseYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const p = s.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  // 回环校验：2024-02-31 会被 new Date 悄悄进位成 3-02，这里挡住
  if (d.getFullYear() !== p[0] || d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) return null;
  return { y: p[0], m: p[1], d: p[2] };
}

function fmtYmd(y, m, d) {
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

// 加 n 个月，月末夹取：2024-01-31 + 6 = 2024-07-31；2024-01-31 + 1 = 2024-02-29
function addMonths(s, n) {
  const p = parseYmd(s);
  if (!p || typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  const total = p.y * 12 + (p.m - 1) + Math.round(n);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(y, m, 0).getDate(); // 当月最后一天
  return fmtYmd(y, m, Math.min(p.d, last));
}

// 日期：'' / 缺省放行，否则必须是能回环的 YYYY-MM-DD
function parseDateField(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { value: '' };
  if (!parseYmd(s)) return { error: '日期格式不正确' };
  return { value: s };
}

function parseShort(v, label, max) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { value: '' };
  if (s.length > max) return { error: `${label}不能超过 ${max} 个字` };
  return { value: s };
}

function parseIntIn(v, min, max) {
  if (v === '' || v == null) return { empty: true };
  const n = Number(v);
  if (!isFinite(n) || isNaN(n) || Math.floor(n) !== n) return { error: true };
  if (n < min || n > max) return { error: true };
  return { value: n };
}

// 把 add/update 的入参规整成一份可直接写库的文档。
// 所有校验都在任何 I/O 之前完成。
function parseCosmetic(event) {
  const name = String(event.name || '').trim();
  if (!name) return { error: '请输入化妆品名称' };
  if (name.length > MAX_NAME) return { error: `名称不能超过 ${MAX_NAME} 个字` };

  const category = String(event.category || '').trim();
  if (!category) return { error: '请选择化妆品种类' };
  if (CATEGORIES.indexOf(category) < 0) return { error: '化妆品种类无效，请重新选择' };

  const brand = parseShort(event.brand, '品牌', MAX_BRAND);
  if (brand.error) return { error: brand.error };
  const shade = parseShort(event.shade, '色号', MAX_SHADE);
  if (shade.error) return { error: shade.error };
  const note = parseShort(event.note, '备注', MAX_NOTE);
  if (note.error) return { error: note.error };

  // 适用妆造存**名称**而非 _id：
  //   ① 仓库已有这个惯例（createBooking 就是拿 style.name 去匹配 timeSlots[*].styles）
  //   ② 妆造改名/删除时优雅降级——客户端渲染时与当前妆造库取交集，
  //      库里没有的名字不出现在筛选 chip 也不产生分组幽灵，文档里原样保留，
  //      改回来链接自动复原，不需要任何迁移脚本
  // ③ 刻意不与 styles 集合校验：妆造库可能正在编辑中，而客户端只能发出它
  //    渲染出来的名字，多一次 .where() 只是白等一个往返
  let styles = [];
  if (Array.isArray(event.styles)) {
    const seen = {};
    styles = event.styles
      .map(s => String(s == null ? '' : s).trim())
      .filter(s => {
        if (!s || s.length > MAX_NAME) return false;
        if (seen[s]) return false;
        seen[s] = 1;
        return true;
      })
      .slice(0, MAX_STYLES);
  }

  const produceDate = parseDateField(event.produceDate);
  if (produceDate.error) return { error: produceDate.error };
  const expireInput = parseDateField(event.expireDate);
  if (expireInput.error) return { error: expireInput.error };

  let shelfMonths = null;
  if (event.shelfMonths !== '' && event.shelfMonths != null) {
    const sm = parseIntIn(event.shelfMonths, 0, MAX_SHELF);
    if (sm.error) return { error: '保质期月数无效' };
    shelfMonths = sm.value;
  }

  // 效期解析：生产日期 + 保质期同时存在时**由云函数重算**，
  // 忽略客户端传的到期日——否则旧版本客户端或手工构造的请求
  // 能写进「生产日期说 6 个月、到期日却是另一天」的不一致三元组。
  // 只有没有生产日期时才采信客户端的到期日。
  // 解析不出来不报错：那是一条合法记录，只是没有保期信息，渲染成中性样式。
  let expireDate = '';
  if (produceDate.value && shelfMonths != null) {
    expireDate = addMonths(produceDate.value, shelfMonths);
  } else if (expireInput.value) {
    expireDate = expireInput.value;
  }

  const qty = parseIntIn(event.qty, 1, MAX_QTY);
  if (qty.empty || qty.error) return { error: '请输入正确的数量' };

  // 剩余量缺省等于总量
  let remain = qty.value;
  const r = parseIntIn(event.remain, 0, MAX_QTY);
  if (!r.empty) {
    if (r.error) return { error: '剩余数量不能大于总数量' };
    if (r.value > qty.value) return { error: '剩余数量不能大于总数量' };
    remain = r.value;
  }

  // 只接受自己上传的 fileID。这里没有「读别人的照片」这种需求，
  // 放开 http:// 等于让构造请求把 <image> 指向任意地址。
  const photo = String(event.photo || '').trim();
  if (photo && !/^cloud:\/\/.+\.(jpg|jpeg|png|webp|heic)$/i.test(photo)) {
    return { error: '照片无效，请重新上传' };
  }

  return {
    cosmetic: {
      name, brand: brand.value, category, shade: shade.value,
      styles, produceDate: produceDate.value, shelfMonths, expireDate,
      qty: qty.value, remain, photo, note: note.value,
    },
  };
}

// 集合不存在时把 -502005 翻译成一句能照做的提示。
// 注意 cosmetics 与 users 不同：它是先写后读的，云数据库会在首次 add() 时隐式创建，
// 所以正常情况下用不到这条消息；留着是为了自动创建被关掉的环境兜底。
function isCollectionMissing(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  return msg.includes('-502005') || msg.includes('collection not exists');
}

const COLLECTION_MISSING_MSG =
  '数据库集合 cosmetics 不存在，请打开云开发控制台 → 数据库 → 新建集合，集合名填 cosmetics，然后重新部署本云函数。';

// 云函数内部翻页，一次调用取完（客户端不用管分页）。
// 只按单字段排序，不做复合查询，所以不需要新建索引（同 adminGetUserProfile 的考虑）。
// _id 序只是个确定性的底座——真正的排序（已过期置顶、越近越前）在客户端做。
async function listCosmetics() {
  const out = [];
  for (let page = 0; page * PAGE_SIZE < MAX_TOTAL; page++) {
    let res;
    try {
      res = await db.collection(COLLECTION)
        .orderBy('_id', 'asc')
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .get();
    } catch (err) {
      if (isCollectionMissing(err)) throw new Error(COLLECTION_MISSING_MSG);
      throw err;
    }
    const batch = res.data || [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

// 增删改都把受影响的那一条原样回传，客户端据此本地打补丁，
// 不必再全量拉一次列表（一次增删从 2 次云函数调用降到 1 次）。
// 回传完整文档而不是 adminStyles 那种精简的 {name, price}：
// 这里客户端要就地更新的是一整行（剩余量、到期日、妆造标签都会变），
// 只回传局部就得让客户端拿旧值拼，迟早拼错。
function toCosmeticDoc(doc, id) {
  const d = doc || {};
  return {
    _id: d._id || id || '',
    name: d.name || '',
    brand: d.brand || '',
    category: d.category || '',
    shade: d.shade || '',
    styles: Array.isArray(d.styles) ? d.styles : [],
    produceDate: d.produceDate || '',
    shelfMonths: d.shelfMonths == null ? null : d.shelfMonths,
    expireDate: d.expireDate || '',
    qty: d.qty || 0,
    remain: d.remain == null ? 0 : d.remain,
    photo: d.photo || '',
    note: d.note || '',
    createTime: d.createTime || null,
    updateTime: d.updateTime || null,
  };
}

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  const { action } = event;
  if (!action) return { success: false, message: '参数不完整' };

  try {
    if (action === 'list') {
      const cosmetics = await listCosmetics();
      return { success: true, cosmetics, total: cosmetics.length };
    }

    if (action === 'add') {
      const parsed = parseCosmetic(event);
      if (parsed.error) return { success: false, message: parsed.error };

      // 允许重名（YSL 325 和 CT 325 都合法），但「同品牌同名称同种类同色号」
      // 一定是手滑重复录了一遍。只按 name 单字段查（复合查询可能要求新索引），
      // 其余字段在内存里比。
      const dup = await db.collection(COLLECTION)
        .where({ name: parsed.cosmetic.name })
        .limit(50)
        .get();
      const clash = (dup.data || []).some(d =>
        d._id &&
        (d.category || '') === parsed.cosmetic.category &&
        (d.shade || '') === parsed.cosmetic.shade &&
        (d.brand || '') === parsed.cosmetic.brand
      );
      if (clash) {
        return { success: false, message: `「${parsed.cosmetic.name}」已经录过了` };
      }

      const countRes = await db.collection(COLLECTION).count();
      if (countRes.total >= MAX_TOTAL) {
        return { success: false, message: `化妆品最多 ${MAX_TOTAL} 件` };
      }

      const addRes = await db.collection(COLLECTION).add({
        data: { ...parsed.cosmetic, createTime: db.serverDate() },
      });
      return {
        success: true,
        message: '已添加',
        // 回传新增的那条（含 add() 生成的真实 _id），客户端可以本地插入而不是重新 list
        cosmetic: toCosmeticDoc(parsed.cosmetic, (addRes && addRes._id) || ''),
      };
    }

    if (action === 'update') {
      const { cosmeticId } = event;
      if (!cosmeticId) return { success: false, message: '参数不完整' };
      const parsed = parseCosmetic(event);
      if (parsed.error) return { success: false, message: parsed.error };

      // 绝不用 set()——它会替换整份文档，连带干掉 createTime
      const res = await db.collection(COLLECTION).doc(cosmeticId).update({
        data: { ...parsed.cosmetic, updateTime: db.serverDate() },
      });
      if (res.stats.updated !== 1) return { success: false, message: '化妆品不存在' };
      return {
        success: true,
        message: '已保存修改',
        cosmetic: toCosmeticDoc(parsed.cosmetic, cosmeticId),
      };
    }

    // 扣减一支。必须原子，不能读回来减一再写回去：
    // 两位化妆师同时点会各读到 3、都写 2，白扣一支。
    // 形状与 createBooking 的时段原子占用一致；_id 等值是主键查找，
    // 不会触发复合索引提示。
    if (action === 'consume') {
      const { cosmeticId } = event;
      if (!cosmeticId) return { success: false, message: '参数不完整' };

      const res = await db.collection(COLLECTION).where({
        _id: cosmeticId,
        remain: db.command.gt(0),
      }).update({
        data: { remain: db.command.inc(-1), updateTime: db.serverDate() },
      });
      if (res.stats.updated !== 1) {
        return { success: false, message: '这一件已经用完了' };
      }

      // 回传真值供客户端打补丁，客户端不必猜自己减到了几
      const after = await db.collection(COLLECTION).doc(cosmeticId).get();
      return { success: true, message: '已用掉一支', cosmetic: toCosmeticDoc(after.data, cosmeticId) };
    }

    if (action === 'delete') {
      const { cosmeticId } = event;
      if (!cosmeticId) return { success: false, message: '参数不完整' };
      // 先读再删：回传名字让客户端在「删除化妆品？」弹窗里回显是哪一条
      let doc = null;
      try {
        const before = await db.collection(COLLECTION).doc(cosmeticId).get();
        doc = before.data || null;
      } catch (e) {
        // 读不到就当不存在，交给下面的 remove 判「化妆品不存在」
        return { success: false, message: '化妆品不存在' };
      }
      const res = await db.collection(COLLECTION).doc(cosmeticId).remove();
      // 注意：云开发 doc().remove() 返回的计数是 stats.removed（不是 deleted）
      const removed = (res.stats && (res.stats.removed != null ? res.stats.removed : res.stats.deleted)) || 0;
      if (removed !== 1) return { success: false, message: '化妆品不存在' };
      return { success: true, message: '已删除', cosmetic: { _id: cosmeticId, name: (doc && doc.name) || '' } };
    }

    return { success: false, message: '无效操作' };
  } catch (err) {
    console.error('adminCosmetics error:', err);
    const message = isCollectionMissing(err) || String(err.message || '').includes(COLLECTION_MISSING_MSG)
      ? COLLECTION_MISSING_MSG
      : '服务器错误：' + err.message;
    return { success: false, message };
  }
};
