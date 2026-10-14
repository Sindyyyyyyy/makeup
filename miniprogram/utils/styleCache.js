// utils/styleCache.js - 妆造库（styles）的共享缓存
//
// 为什么只有妆造库有缓存：妆造库是低频数据（她自己维护，几十条上限），
// 而预约和时段是**实时状态**——刚放开的时段、刚确认的预约必须立刻看到，
// 缓存会让化妆师对着过期的界面做决定。所以只有妆造库走这里。
//
// 之前 scheduleGrid（弹窗里的快捷按钮）和 pages/adminStyles（妆造管理页）
// 各自独立调 adminStyles{action:'list'}，一次后台会话里能拉两遍，
// 妆造管理页增删一条还要再全量拉一遍。一份共用缓存 + 本地打补丁后，
// 一次增删从 2 次云函数调用降到 1 次。
//
// 缓存不参与鉴权：它只缓存「妆造有哪些」，不含任何令牌或身份信息，
// 也不因为缓存命中就绕过服务端的 UNAUTHORIZED（缓存未命中时照常发请求，
// 令牌无效时云函数会返回 UNAUTHORIZED，由各页面自己处理）。

const CACHE_KEY = 'style_library_cache';
const TOKEN_KEY = 'admin_token';

// 5 分钟：只用来挡住「同一会话内重复拉取」，不至于让手动下拉刷新生效
const DEFAULT_TTL = 5 * 60 * 1000;

// 写入缓存。增删改成功后本地改了列表就调它，让下一次读取直接命中。
function saveStyles(styles) {
  try {
    wx.setStorageSync(CACHE_KEY, { styles: styles || [], at: Date.now() });
  } catch (e) {
    // 缓存写不进去不该拖垮功能，只是下次还要多打一次云函数而已
    console.warn('妆造库缓存写入失败', e);
  }
}

function invalidate() {
  wx.removeStorageSync(CACHE_KEY);
}

// 读妆造库。opts.maxAgeMs 为 0 时强制绕过缓存（下拉刷新用）。
// 返回值形状与 adminStyles{action:'list'} 的响应一致，
// 额外带一个 fromCache 标记，方便调用方决定要不要显示 loading。
async function getStyles(opts) {
  const maxAge = opts && typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : DEFAULT_TTL;
  if (maxAge > 0) {
    const cached = wx.getStorageSync(CACHE_KEY);
    if (cached && Array.isArray(cached.styles) && Date.now() - (cached.at || 0) < maxAge) {
      return { success: true, styles: cached.styles, fromCache: true };
    }
  }
  const res = await wx.cloud.callFunction({
    name: 'adminStyles',
    data: { action: 'list', token: wx.getStorageSync(TOKEN_KEY) },
  });
  const r = (res && res.result) || null;
  if (r && r.success) saveStyles(r.styles || []);
  return r;
}

module.exports = { getStyles, saveStyles, invalidate, DEFAULT_TTL };