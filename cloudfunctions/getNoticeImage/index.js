const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 化妆注意事项图片现在存在数据库集合 noticeImages 里（化妆师在后台的
// 「注意事项管理」页自己上传），这里负责把它换成顾客能看的 https 临时链接。
//
// 为什么必须走临时链接：图存在云存储，存储桶保持「仅创建者可读写」即可，
// 这里用 admin SDK 的 getTempFileURL 绕过 ACL 下发带签名的 https 链接。
// 直接把 cloud:// fileID 丢给顾客的 <image> 会因 ACL 校验而一片空白
// （同素颜照那个坑）。另外，包内图片长按不会弹出保存菜单，
// 所以想让顾客「长按存相册」也只能走临时链接这条路。
//
// 按语言分桶：中英文是两组独立的图片。顾客按自己的界面语言取对应那组，
// 该语言一张都没有时回退中文那组（英文版还没上传时的老行为）。
const COLLECTION = 'noticeImages';
const META_ID = 'meta';

// 旧版把注意事项图硬编码在这里。数据库里还没有任何图、也没有「被管理过」的
// 标记时，先拿这张顶上——等化妆师打开过一次「注意事项管理」，
// 它就会被迁进数据库，这张常量从此不再直接下发给顾客。
const LEGACY_FILE_ID = 'cloud://cloud1-d1g82tuwue6aeadb2.636c-cloud1-d1g82tuwue6aeadb2-1502005871/notice.jpg';

// 每种语言最多 5 张（服务端硬限制，adminNoticeImages 里同一份常量）。
const MAX_PER_LANG = 5;

const MSG = {
  zh: {
    notConfigured: '注意事项图片未配置',
    failed: '注意事项图片获取失败',
  },
  en: {
    notConfigured: 'Notice image is not configured',
    failed: 'Failed to get notice images',
  },
};

// 客户端传的 lang 不认识就当中文。老版本客户端不传这个字段，老版本云函数也不认识它，
// 两个方向的失败模式都是「显示中文图」。
function normalizeLang(l) {
  return l === 'en' ? 'en' : 'zh';
}

// 集合不存在 = 还没人管过注意事项图（第一次迁移之前）。这种情况不算错误，
// 由调用方回退到旧图；其它错误照常抛出去。
function isCollectionMissing(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  return msg.includes('-502005') || msg.includes('collection not exists');
}

// 读某种语言的图片文档。返回 null 表示「集合还不存在」。
async function readByLang(lang) {
  try {
    // 单字段查询 + 排序放在内存里做：where({lang}) 是单字段查询不会要索引，
    // 但 where + orderBy 组合可能要求复合索引。
    const res = await db.collection(COLLECTION).where({ lang }).limit(MAX_PER_LANG + 5).get();
    const docs = (res.data || []).filter((d) => d && d.fileID);
    docs.sort((a, b) => {
      const sa = typeof a.sort === 'number' ? a.sort : 999;
      const sb = typeof b.sort === 'number' ? b.sort : 999;
      if (sa !== sb) return sa - sb;
      const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
      const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return String(a._id).localeCompare(String(b._id));
    });
    return docs;
  } catch (err) {
    if (isCollectionMissing(err)) return null;
    throw err;
  }
}

// 这个集合有没有被化妆师管理过（管理过就说明旧图不该再自动冒出来）。
async function isManaged() {
  try {
    await db.collection(COLLECTION).doc(META_ID).get();
    return true;
  } catch (err) {
    return false;
  }
}

// admin SDK 换临时链接。返回 fileID → url 的映射而不是数组：
// 单张失败时只丢那一张，按下标回填会让后面的图全部错位。
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

exports.main = async (event) => {
  const lang = normalizeLang(event && event.lang);
  const msg = MSG[lang];
  try {
    let docs = await readByLang(lang);
    // 该语言还没有图就回退中文那组（英文版还没上传时的老行为）
    if ((!docs || !docs.length) && lang !== 'zh') {
      docs = await readByLang('zh');
    }

    if (!docs || !docs.length) {
      // 集合被管理过 = 化妆师自己清空了列表，那就不要再塞旧图回去
      if (await isManaged()) {
        return { success: true, images: [], url: '' };
      }
      const legacy = await tempUrlMap([LEGACY_FILE_ID]);
      const url = legacy[LEGACY_FILE_ID] || '';
      if (!url) return { success: false, message: msg.notConfigured };
      return { success: true, images: [url], url };
    }

    const ids = docs.map((d) => d.fileID);
    const map = await tempUrlMap(ids);
    const images = ids.map((id) => map[id]).filter(Boolean);
    if (!images.length) return { success: false, message: msg.failed };

    // url 字段是给老版本客户端留的（它只认单张），新客户端读 images 数组。
    return { success: true, images, url: images[0] };
  } catch (err) {
    console.error('getNoticeImage error:', err);
    return { success: false, message: msg.failed };
  }
};
