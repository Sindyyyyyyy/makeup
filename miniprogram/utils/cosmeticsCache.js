// utils/cosmeticsCache.js - 化妆品库（cosmetics）的共享缓存
//
// 为什么可以缓存：和 utils/styleCache.js 同一个理由——化妆品库是化妆师
// 自己维护的低频数据，而预约和时段是**实时状态**（刚放开的时段、刚确认的预约
// 必须立刻看到）。所以缓存只覆盖化妆品库，且只缓存「有哪些化妆品」，
// 不含任何令牌或身份信息，也不因为缓存命中就绕过服务端的 UNAUTHORIZED。
//
// 数量（remain）是这套库里唯一偏实时的字段，所以任何数量变化都走
// 云函数写回 + 本地打补丁，绝不从缓存里读出来「直接减一」——
// 那样两位化妆师同时操作时会各自减成功一次，云端却只扣了一支。

const expiry = require('./expiry.js');

const CACHE_KEY = 'cosmetics_library_cache';
const TOKEN_KEY = 'admin_token';

// 5 分钟：只用来挡住「同一会话内重复拉取」，不至于让手动下拉刷新生效
const DEFAULT_TTL = 5 * 60 * 1000;

function saveCosmetics(list) {
  try {
    wx.setStorageSync(CACHE_KEY, { cosmetics: list || [], at: Date.now() });
  } catch (e) {
    // 缓存写不进去不该拖垮功能，只是下次还要多打一次云函数而已
    console.warn('化妆品库缓存写入失败', e);
  }
}

function invalidate() {
  wx.removeStorageSync(CACHE_KEY);
}

// 只读缓存，不发云函数。个人中心的到期角标走这里——
// 它是个「有没有东西过期」的提示，不值得为它花一次云函数调用。
function readCache() {
  const hit = wx.getStorageSync(CACHE_KEY);
  return (hit && Array.isArray(hit.cosmetics)) ? hit.cosmetics : null;
}

// 读化妆品库。opts.maxAgeMs 为 0 时强制绕过缓存（下拉刷新用）。
// 返回值形状与 adminCosmetics{action:'list'} 的响应一致，
// 额外带一个 fromCache 标记，方便调用方决定要不要显示 loading。
async function getCosmetics(opts) {
  const maxAge = opts && typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : DEFAULT_TTL;
  if (maxAge > 0) {
    const hit = wx.getStorageSync(CACHE_KEY);
    if (hit && Array.isArray(hit.cosmetics) && Date.now() - (hit.at || 0) < maxAge) {
      return { success: true, cosmetics: hit.cosmetics, total: hit.cosmetics.length, fromCache: true };
    }
  }
  const res = await wx.cloud.callFunction({
    name: 'adminCosmetics',
    data: { action: 'list', token: wx.getStorageSync(TOKEN_KEY) },
  });
  const r = (res && res.result) || null;
  if (r && r.success) saveCosmetics(r.cosmetics || []);
  return r;
}

// 已过期数 + 临期数（soon3 + soon6，不含已过期）。
// 纯计算，调用方手里已经有数组，所以调用它**不发云函数**。
// 个人中心的角标和化妆品页顶部的概览条共用它，两处数字才不会打架。
function summarize(list, now) {
  let expired = 0;
  let soon = 0;
  (list || []).forEach(c => {
    const lv = expiry.expiryLevel(c && c.expireDate, now);
    if (lv === 'expired') expired++;
    else if (lv === 'soon3' || lv === 'soon6') soon++;
  });
  return { expired, soon, total: (list || []).length };
}

function summaryText(s) {
  return s && s.total ? `已过期 ${s.expired} · 临期 ${s.soon}` : '去管理';
}

module.exports = {
  CACHE_KEY,
  DEFAULT_TTL,
  getCosmetics,
  saveCosmetics,
  readCache,
  invalidate,
  summarize,
  summaryText,
};
