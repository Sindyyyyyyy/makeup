const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 注意事项图片集合：一个文档一张图。
// 文档形状：{ lang: 'zh'|'en', fileID, sort, createTime, updateTime }
// lang 是这张图给谁看的：中英文是两组独立的图片，顾客按自己的界面语言取对应那组。
// 集合里还放一个 _id='meta' 的标记文档，它没有 lang 字段，所以任何
// 按 lang 过滤的查询都不会把它带出来（见下方 META_ID）。
const COLLECTION = 'noticeImages';
const META_ID = 'meta';

// 旧版把注意事项图硬编码在 getNoticeImage 里（云存储 notice/notice.jpg）。
// 第一次打开「注意事项管理」时把它迁进数据库，化妆师就能像管理别的图片一样
// 删掉 / 替换它；迁完之前顾客端仍由 getNoticeImage 直接下发这张图。
const LEGACY_ID = 'legacy-zh';
const LEGACY_FILE_ID = 'cloud://cloud1-d1g82tuwue6aeadb2.636c-cloud1-d1g82tuwue6aeadb2-1502005871/notice.jpg';

// 每种语言最多 5 张。服务端硬限制：客户端的按钮只是第一层。
const MAX_PER_LANG = 5;
const LANGS = ['zh', 'en'];

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

// 集合不存在时把 -502005 翻译成一句能照做的提示。
function isCollectionMissing(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  return msg.includes('-502005') || msg.includes('collection not exists');
}

const COLLECTION_MISSING_MSG =
  '数据库集合 noticeImages 不存在，请打开云开发控制台 → 数据库 → 新建集合，集合名填 noticeImages，然后重新部署本云函数。';

// 云存储 fileID 的白名单：只接受自己上传的图片文件。
// 放开 http:// 等于让构造请求把 <image> 指向任意地址。
const FILE_ID_RE = /^cloud:\/\/.+\.(jpg|jpeg|png|webp|heic)$/i;

function normalizeLang(l) {
  return l === 'en' ? 'en' : 'zh';
}

// admin SDK 换 https 临时链接绕过存储桶 ACL（桶保持「仅创建者可读写」）。
// 这是存储 API 调用，不消耗云函数调用次数。
// 返回 fileID → url 的映射（而不是一个数组）：单张失败时只丢那一张，
// 用数组按下标回填会让后面的图全部错位。
async function tempUrlMap(fileIDs) {
  const map = {};
  if (!Array.isArray(fileIDs) || !fileIDs.length) return map;
  try {
    const res = await cloud.getTempFileURL({ fileList: fileIDs });
    (res.fileList || []).forEach((f) => {
      if (f && f.status === 0 && f.tempFileURL && f.fileID) map[f.fileID] = f.tempFileURL;
    });
  } catch (err) {
    console.error('getTempFileURL error:', err);
  }
  return map;
}

// 读整个集合（图片文档 + meta 标记）。数据量极小（≤ 10 张图 + 1 个标记），
// 一次取完，不分页也不排序（排序在内存里做，见 sortImages）。
//
// 集合还不存在时返回空数组而不是报错：第一次进管理页要靠这个空数组触发
// 「迁移旧图」，而且云数据库在首次写入时会隐式创建集合。
// 真正写不进去时（环境关掉了自动创建）由外层的 catch 翻译成一句能照做的提示。
async function readAll() {
  try {
    const res = await db.collection(COLLECTION).limit(50).get();
    return res.data || [];
  } catch (err) {
    if (isCollectionMissing(err)) return [];
    throw err;
  }
}

function isImageDoc(d) {
  return !!(d && typeof d.lang === 'string' && LANGS.indexOf(d.lang) >= 0);
}

// 排序：先按 sort，没有 sort 的（老文档）按 createTime，再按 _id 兜底，
// 保证同一批图片每次拉出来的顺序一模一样，顾客左右滑动的次序不会跳。
function sortImages(list) {
  return list.slice().sort((a, b) => {
    const sa = typeof a.sort === 'number' ? a.sort : 999;
    const sb = typeof b.sort === 'number' ? b.sort : 999;
    if (sa !== sb) return sa - sb;
    const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
    const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return String(a._id).localeCompare(String(b._id));
  });
}

function toImageDoc(d, url) {
  return {
    id: d._id || '',
    lang: d.lang || 'zh',
    fileID: d.fileID || '',
    url: url || '',
    sort: typeof d.sort === 'number' ? d.sort : 0,
    createTime: d.createTime || null,
  };
}

// 第一次打开管理页时，把旧版那张硬编码的图迁进数据库。
// 判据是「集合里既没有图片文档，也没有 meta 标记」——也就是从来没人管过。
// 一旦迁过（或化妆师自己删光了图），就不再自动塞回来：她删掉就是不要了。
async function ensureSeeded(docs) {
  const hasImage = docs.some(isImageDoc);
  const hasMeta = docs.some((d) => d._id === META_ID);
  if (hasImage || hasMeta) return false;

  const legacyData = {
    lang: 'zh',
    fileID: LEGACY_FILE_ID,
    sort: 0,
    seeded: true,
    createTime: db.serverDate(),
    updateTime: db.serverDate(),
  };
  // 先写旧图：集合还不存在时，云数据库会在首次写入时隐式创建它。
  // set() 带自定义 _id 在集合不存在时会失败，那就退化成 add()。
  try {
    await db.collection(COLLECTION).doc(LEGACY_ID).set({ data: legacyData });
  } catch (err) {
    if (!isCollectionMissing(err)) throw err;
    await db.collection(COLLECTION).add({ data: legacyData });
  }
  // meta 必须用固定 _id（getNoticeImage 靠 doc('meta') 判断「被管理过」），
  // 所以它只能 set，不能 add。此时集合已经建好了。
  await db.collection(COLLECTION).doc(META_ID).set({
    data: { type: 'meta', updateTime: db.serverDate() },
  });
  return true;
}

// 给每个文档挂上临时链接。挂不上的（文件已被删）url 为空串，客户端会显示占位。
async function withTempUrls(images) {
  const map = await tempUrlMap(images.map((i) => i.fileID).filter(Boolean));
  return images.map((i) => ({ ...i, url: map[i.fileID] || '' }));
}

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  const action = event && event.action;
  if (!action) return { success: false, message: '参数不完整' };

  try {
    // ============ 列表 ============
    if (action === 'list') {
      let docs = await readAll();
      // 第一次进来：把旧版那张图迁进数据库，化妆师看到的就是顾客正在看的那张
      if (await ensureSeeded(docs)) docs = await readAll();
      const images = sortImages(docs.filter(isImageDoc)).map((d) => toImageDoc(d));
      const withUrls = await withTempUrls(images);
      return {
        success: true,
        images: withUrls,
        maxPerLang: MAX_PER_LANG,
        total: withUrls.length,
      };
    }

    // ============ 新增 ============
    if (action === 'add') {
      const lang = normalizeLang(event.lang);
      const fileID = String(event.fileID || '').trim();
      if (!fileID) return { success: false, message: '参数不完整' };
      if (!FILE_ID_RE.test(fileID)) {
        return { success: false, message: '图片无效，请重新上传' };
      }

      const docs = await readAll();
      const sameLang = docs.filter((d) => isImageDoc(d) && d.lang === lang);
      if (sameLang.length >= MAX_PER_LANG) {
        return { success: false, message: `注意事项图片最多 ${MAX_PER_LANG} 张` };
      }

      // 新图排在最后：sort 取同语言当前的最大值 + 1。
      // **不能**用「当前条数」——删过一张之后 sort 会有缺口（比如 0,1,2,4），
      // 用条数会跟已有的 sort 撞号，两张图的先后就变成随机的了。
      const ordered = sortImages(sameLang);
      const maxSort = ordered.reduce((m, d) => {
        const s = typeof d.sort === 'number' ? d.sort : 0;
        return s > m ? s : m;
      }, -1);
      const sort = maxSort + 1;
      const addRes = await db.collection(COLLECTION).add({
        data: {
          lang,
          fileID,
          sort,
          createTime: db.serverDate(),
          updateTime: db.serverDate(),
        },
      });
      const id = (addRes && addRes._id) || '';
      // 标记这个集合已经被管过了：getNoticeImage 的旧图兜底从此不再生效
      await db.collection(COLLECTION).doc(META_ID).set({
        data: { type: 'meta', updateTime: db.serverDate() },
      }).catch((e) => console.warn('写 meta 标记失败（不影响本次操作）:', e));
      const urlMap = await tempUrlMap([fileID]);
      const url = urlMap[fileID] || '';
      return {
        success: true,
        message: '已上传',
        image: toImageDoc({ _id: id, lang, fileID, sort }, url),
      };
    }

    // ============ 删除 ============
    if (action === 'delete') {
      const id = String(event.id || '').trim();
      if (!id) return { success: false, message: '参数不完整' };

      let doc = null;
      try {
        const before = await db.collection(COLLECTION).doc(id).get();
        doc = before.data || null;
      } catch (e) {
        return { success: false, message: '这张注意事项不存在' };
      }
      if (!doc || !isImageDoc(doc)) {
        return { success: false, message: '这张注意事项不存在' };
      }

      const res = await db.collection(COLLECTION).doc(id).remove();
      // 注意：云开发 doc().remove() 返回的计数是 stats.removed（不是 deleted）
      const removed = (res.stats && (res.stats.removed != null ? res.stats.removed : res.stats.deleted)) || 0;
      if (removed !== 1) return { success: false, message: '这张注意事项不存在' };

      // 云存储里的文件顺手删掉，别在桶里堆垃圾。
      // 迁移过来的那张（LEGACY_ID）不删文件：它可能是别处还在引用的老资源，
      // 留着最坏也就是占点空间，删了却可能让别处的旧链接失效。
      if (id !== LEGACY_ID && doc.fileID) {
        try {
          await cloud.deleteFile({ fileList: [doc.fileID] });
        } catch (e) {
          console.warn('删除云存储文件失败（不影响删库记录）:', e);
        }
      }

      await db.collection(COLLECTION).doc(META_ID).set({
        data: { type: 'meta', updateTime: db.serverDate() },
      }).catch((e) => console.warn('写 meta 标记失败（不影响本次操作）:', e));

      return { success: true, message: '已删除', id };
    }

    // ============ 排序（上移 / 下移）============
    if (action === 'move') {
      const id = String(event.id || '').trim();
      const dir = event.dir === 'down' ? 'down' : 'up';
      if (!id) return { success: false, message: '参数不完整' };

      const docs = await readAll();
      const sameLang = sortImages(docs.filter((d) => isImageDoc(d) && d.lang === normalizeLang(event.lang)));
      const idx = sameLang.findIndex((d) => d._id === id);
      if (idx < 0) return { success: false, message: '这张注意事项不存在' };

      const swapWith = dir === 'down' ? idx + 1 : idx - 1;
      if (swapWith < 0 || swapWith >= sameLang.length) {
        return { success: false, message: '已经在最' + (dir === 'down' ? '后' : '前') + '了' };
      }
      const a = sameLang[idx];
      const b = sameLang[swapWith];
      // 两张图的 sort 互换即可（sort 不连续也没关系，排序只看相对大小）
      const aSort = typeof a.sort === 'number' ? a.sort : idx;
      const bSort = typeof b.sort === 'number' ? b.sort : swapWith;
      await db.collection(COLLECTION).doc(a._id).update({
        data: { sort: bSort, updateTime: db.serverDate() },
      });
      await db.collection(COLLECTION).doc(b._id).update({
        data: { sort: aSort, updateTime: db.serverDate() },
      });
      return { success: true, message: dir === 'down' ? '已下移' : '已上移' };
    }

    return { success: false, message: '无效操作' };
  } catch (err) {
    console.error('adminNoticeImages error:', err);
    const message = isCollectionMissing(err) || String(err.message || '').includes(COLLECTION_MISSING_MSG)
      ? COLLECTION_MISSING_MSG
      : '服务器错误：' + err.message;
    return { success: false, message };
  }
};
