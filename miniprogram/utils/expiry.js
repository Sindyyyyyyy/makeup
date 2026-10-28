// utils/expiry.js - 化妆品的效期推算与分档
//
// 全部日期用 'YYYY-MM-DD' **字符串**表示，不存 Date 对象。三个原因：
//   ① 字典序即时间序，`expireDate < today` 就是「早于」，一行搞定、没有时区；
//   ② 云函数是 UTC、客户端是东八区。存 Date 再读回来会偏一天，
//      足以让一条从「已过期」翻成「正常」——而这正是最不能搞错的一个判断；
//   ③ 录入用的就是 <picker mode="date">，它本来就给字符串。
//
// 分档只在客户端算，不在云函数算：分档依赖「现在」，而 App 关着的时候
// 时间在走，服务端算出来的档位会过期。云函数只抄了一份 addMonths 用来落库。

// 按本地时区解析：new Date(y, m-1, d) 是本地构造器，
// 不会像 new Date('2024-01-31') 那样被当成 UTC 零点而在东八区偏一天。
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

function todayStr() {
  const d = new Date();
  return fmtYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// 加 n 个月，月末夹取：
//   2024-01-31 + 6 = 2024-07-31（七月 31 天，不夹）
//   2024-01-31 + 1 = 2024-02-29（二月闰年 29 天，31 夹到 29）
//   2023-01-31 + 1 = 2023-02-28
function addMonths(s, n) {
  const p = parseYmd(s);
  // n < 0 直接拒绝：输入框 type="number" 能敲进负号，不挡的话会算出
  // 「生产日期往前推」这种说得通但没意义的到期日（云端会拒，只是表单里的提示在骗人）
  if (!p || typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  const total = p.y * 12 + (p.m - 1) + Math.round(n);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;           // total >= 0 时 m 落在 1..12
  const last = new Date(y, m, 0).getDate(); // 当月最后一天
  return fmtYmd(y, m, Math.min(p.d, last));
}

// 反推整月：2024-01-31 → 2024-07-31 得 6；→ 2024-08-30 只得 5（日不足则减 1）
function monthsBetween(fromStr, toStr) {
  const a = parseYmd(fromStr);
  const b = parseYmd(toStr);
  if (!a || !b) return null;
  let m = (b.y * 12 + b.m) - (a.y * 12 + a.m);
  if (b.d < a.d) m -= 1;
  return m >= 0 ? m : null;
}

// 距到期还有几天（整数，负数=已过期几天）。无到期日返回 null。
function daysLeft(expireDate, now) {
  const a = parseYmd(now || todayStr());
  const b = parseYmd(expireDate);
  if (!a || !b) return null;
  return Math.round((new Date(b.y, b.m - 1, b.d) - new Date(a.y, a.m - 1, a.d)) / 86400000);
}

// 效期分档。阈值跟着日历走，所以「3 个月内到期」永远是 3 个日历月而非 90 天。
//   expired 已过期 / soon3 3 个月内 / soon6 6 个月内 / ok 正常 / none 无保期
function expiryLevel(expireDate, now) {
  if (!parseYmd(expireDate)) return 'none';
  const today = now || todayStr();
  if (expireDate < today) return 'expired';
  if (expireDate <= addMonths(today, 3)) return 'soon3';
  if (expireDate <= addMonths(today, 6)) return 'soon6';
  return 'ok';
}

// 录入时的双向推导：和云函数 parseCosmetic 里的解析是同一套规则，
// 云端在写库前会再算一遍，所以这里算错也不会把数据写坏，只会让表单里的
// 实时提示对不上——但两边同规则是为了提示和落库结果永远一致。
// 返回 { expireDate, shelfMonths }
function resolveExpiry(produceDate, shelfMonths, expireDate) {
  const hasShelf = shelfMonths !== '' && shelfMonths != null && isFinite(Number(shelfMonths));
  if (parseYmd(produceDate) && hasShelf) {
    return {
      expireDate: addMonths(produceDate, Number(shelfMonths)),
      shelfMonths: Number(shelfMonths),
    };
  }
  if (parseYmd(expireDate)) {
    return {
      expireDate,
      // 反推只在有生产日期时成立；没有就保持空（库里有妆造但不知道保多久是常态）
      shelfMonths: parseYmd(produceDate) ? monthsBetween(produceDate, expireDate) : null,
    };
  }
  return { expireDate: '', shelfMonths: null };
}

module.exports = {
  parseYmd,
  todayStr,
  addMonths,
  monthsBetween,
  daysLeft,
  expiryLevel,
  resolveExpiry,
};
