const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// ============ 过期预约自动结算 ============
// 由 config.json 里的定时触发器每小时调用一次。
// 这段逻辑原先被复制粘贴进 listWeekSchedule / listMyBookings / adminGetBookings
// 三个「读取类」函数，导致每次读列表都要全表扫一遍 bookings（最坏 301 次 DB 往返，
// 而 adminGetBookings 分页，翻一页就重扫一次）。改为定时触发后，热路径上的
// 列表查询回到 1-2 次 DB 读。
const SWEEP_LIMIT = 100;
// `in` 的元素个数有上限，超过就分批查（库里没有复合索引用，只有单字段）
const IN_CHUNK = 50;

// ============ 时段配置 ============
// 结束时刻是数据不是代码：权威值在 timeSlots 集合的 _id='slot_times' 文档里
//   { morning:{start,end}, afternoon:{...}, evening:{...},
//     overrides: { 'YYYY-MM-DD': { morning:{start,end} } } }
// 某一天某时段的结束时刻 = overrides[date][slot].end ?? 全局的 slot.end。
// 与 miniprogram/utils/slots.js 是同一套规则（两个目录不共享文件系统，只能各抄一份）。
const CONFIG_DOC_ID = 'slot_times';
const DEFAULT_TIMES = {
  morning: { start: '09:30', end: '11:30' },
  afternoon: { start: '14:00', end: '17:00' },
  evening: { start: '18:00', end: '21:00' },
};

// 读配置文档。文档还不存在（第一次用）时退回默认值。
async function readSlotTimes() {
  try {
    const res = await db.collection('timeSlots').doc(CONFIG_DOC_ID).get();
    const d = res && res.data;
    if (!d) return { ...DEFAULT_TIMES, overrides: {} };
    const out = { overrides: (d.overrides && typeof d.overrides === 'object') ? d.overrides : {} };
    ['morning', 'afternoon', 'evening'].forEach(k => {
      const t = d[k];
      out[k] = (t && t.start && t.end) ? { start: t.start, end: t.end } : { ...DEFAULT_TIMES[k] };
    });
    return out;
  } catch (e) {
    return { ...DEFAULT_TIMES, overrides: {} };
  }
}

// 某一天某个时段的结束时刻（单日覆盖优先）
function effectiveEnd(times, date, slot) {
  const day = times && times.overrides && times.overrides[date];
  const ov = day && day[slot];
  if (ov && ov.end) return ov.end;
  const g = times && times[slot];
  return (g && g.end) || '';
}

// 'HH:MM' → 从 00:00 起的分钟数；不是合法时刻则返回 null
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// 云函数运行时区不保证是东八区，这里统一按 UTC+8 计算「今天」和当前时刻
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

// ============ 订阅消息（按仓库约定各抄一份，不共享模块）============
// 模板 ID 在 公众平台 → 订阅消息 → 我的模板 申请后填写。
// 与 miniprogram/utils/notify.js、adminUpdateBooking 保持一致，改一处要改所有发消息的云函数。
//
// 为什么定时结算也要发消息：顾客下单时一次性授权了「标记完成 → 顾客（提醒评价）」
// 这条模板，**那 1 条发送额度是跟这一单绑定的** —— 无论最后是化妆师手动点「标记完成」，
// 还是定时结算把 confirmed 自动翻成 completed，这一条提醒都该发出去一次。
// 之前这个函数不发提醒，于是自动完成的单顾客收不到消息、不知道可以评价了。
const TPL_CUSTOMER_REVIEW = '7nqJY8IDCfQQ0n69vum6opcRmFlCV2XVEYJVpX0d8PY'; // 标记完成 → 顾客（提醒评价）

// 订阅消息卡片点开后打开哪个版本：
//   'trial'   测试期用这个 —— 体验成员随时能打开，长期有效
//   'formal'  正式上线前改成这个 —— 线上普通顾客只认这个
//   'developer' 只在开发者工具扫码时有效，几分钟就过期，点卡片会提示
//              「开发版小程序已过期」，所以不要用它给顾客测。
const MINI_STATE = 'trial';

const PAGE_HOME = 'pages/index/index'; // 无前导斜杠，须与 app.json 注册项逐字一致

// thing 类型上限 20 字，超了整条消息发不出去（47003）
function clip(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}

// 服务日期带上这一单的开始时间（'2026-10-30 09:30:00'）。
// 开始时间从预约文档自己那份快照（slotName）里切出来，不要抄一份硬编码的时间表 ——
// 化妆师改过时段起止时间后 slotName 会被 adminSlotTimes 同步更新，这里自然跟着准。
// 缺时段就退化成纯日期，仍然能发出去。
//
// ⚠️ 不要写整段区间（'2026-10-30 09:30-11:30'）—— 平台会判非法，整条消息 47003 发不出去。
function fmtDateTime(date, slotName) {
  const start = String(slotName || '').split('-')[0] || '';
  if (!start) return String(date || '');
  return `${date} ${start}:00`;
}

// 发订阅消息。永远不抛：43101（没订阅/额度用尽）是业务常态，不是异常。
// 调用方可以直接 await，失败只会拿到 false —— 自动结算流程毫发无损。
//
// ⚠️ 这个「永不抛」是刻意的结构性保证：结算逻辑不能因为一条推送发不出去就把
// 已经翻成 completed 的单当成失败（那样下个小时的定时器会再翻一次）。
// 排障入口是下面这两条日志（控制台 → 云函数 → sweepOverdue → 日志 → 搜
// subscribeMessage）。常见 code：43101 没订阅/额度用尽（最常见，不用管）、
// 47003/47004/47006 模板字段对不上、40037 模板 ID 错、41030 page 路径错、
// -501001 config.json 权限没生效（改完要等约 10 分钟缓存过期）。
async function sendSubscribeMessage(opts) {
  const { touser, templateId, page, data } = opts || {};
  if (!touser || !templateId) return false;
  try {
    const res = await cloud.openapi.subscribeMessage.send({
      touser,
      templateId,
      page,
      miniprogramState: MINI_STATE,
      data,
    });
    // 成功日志是故意留的：没有它，端到端验证时无法区分「没触发」和「触发但被拒」
    console.log('subscribeMessage ok', templateId, JSON.stringify(res || {}));
    return true;
  } catch (err) {
    const code = (err && (err.errCode || err.errcode)) || '';
    const text = [err && err.errMsg, err && err.message].filter(Boolean).join(' | ');
    console.warn('subscribeMessage 跳过', 'code=' + code, 'touser=' + touser, text);
    return false;
  }
}
// ================================================================

// 按日期批量查时段文档（`in` 分批，避免元素个数超限）
async function querySlotsByDate(dates) {
  const map = new Map();
  const uniq = Array.from(new Set(dates.filter(Boolean)));
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const batch = uniq.slice(i, i + IN_CHUNK);
    try {
      const res = await db.collection('timeSlots').where({ date: db.command.in(batch) }).get();
      (res.data || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
    } catch (e) {
      console.warn('autoExpireOverdue 查询时段失败:', e.message);
    }
  }
  return map;
}

// pending 且时段已过 → rejected；confirmed 且时段已过 → completed
async function autoExpireOverdue() {
  const now = beijingNow();
  let res;
  try {
    // 只按 status 单字段过滤（复合条件需要数据库索引），日期在内存里判定
    res = await db.collection('bookings')
      .where({ status: db.command.in(['pending', 'confirmed']) })
      .limit(SWEEP_LIMIT)
      .get();
  } catch (e) {
    console.warn('autoExpireOverdue 查询失败，跳过本次结算:', e.message);
    return { expired: 0 };
  }

  // 结束时刻来自配置（单日覆盖优先），不是写死的整数小时
  const times = await readSlotTimes();

  // 先在内存里筛出真正过期的，省掉对不过期条目的写尝试
  const overdueList = (res.data || []).filter((b) => {
    if (!b || !b.date) return false;
    if (b.date < now.date) return true;      // 过去的日子，一律结算
    if (b.date > now.date) return false;     // 还没到，不动
    const end = effectiveEnd(times, b.date, b.slot);
    const em = toMinutes(end);
    if (em === null) return false;           // 结束时刻不认得，宁可不结算也不误杀
    return now.hour * 60 + now.minute >= em;
  });
  if (overdueList.length === 0) return { expired: 0 };

  // 与 adminUpdateBooking 保持一致的时段副作用：
  // 自动拒绝要释放时段占用，自动完成只打 done 标记。
  // timeSlots 按 date 去重后再查——同一批过期预约常常落在同一天（一天 3 个时段），
  // 原来每条预约各查一次，这里每日期只查一次。
  const dates = Array.from(new Set(overdueList.map(b => b.date)));
  const slotDocs = await querySlotsByDate(dates);

  // 各条预约之间互不影响，并发执行（原实现是完全串行的）
  const results = await Promise.all(overdueList.map(async (b) => {
    const nextStatus = b.status === 'pending' ? 'rejected' : 'completed';
    let updated = 0;
    try {
      // 条件更新：状态被别人（管理员/顾客）改过就跳过，避免覆盖
      const upd = await db.collection('bookings').where({
        _id: b._id,
        status: b.status,
      }).update({ data: { status: nextStatus, updateTime: db.serverDate() } });
      updated = upd.stats.updated;
    } catch (e) {
      console.warn('autoExpireOverdue 更新失败', b._id, e.message);
      return 0;
    }
    if (updated === 0) return 0;

    // 自动完成 → 提醒顾客评价（模板 D → 顾客）。
    //
    // 与 adminUpdateBooking 里「标记完成」那条路径发的是**同一个模板**，两条路径互斥：
    // 状态更新用的是带 status 条件的 CAS，updated===0 说明状态已被别人（化妆师/顾客）
    // 改过，这条直接跳过 —— 所以一单最多发出去一条提醒，正好对上顾客下单时那 1 次授权。
    //
    // 位置在 CAS 成功之后：不会出现「其实没完成却收到提醒」。
    // sendSubscribeMessage 永不抛，发不出去也不会影响结算结果。
    //
    // 只在 completed 时发：pending → rejected 那条不需要顾客评价。
    if (nextStatus === 'completed') {
      await sendSubscribeMessage({
        touser: b._openid,   // 预约文档自己记着顾客的 openid
        templateId: TPL_CUSTOMER_REVIEW,
        page: PAGE_HOME,
        data: {
          // key 与公众平台模板详情页一一对应，改模板要改这里
          date6: { value: clip(fmtDateTime(b.date, b.slotName), 32) },  // 服务日期
          thing3: { value: clip(b.styleName || '化妆预约', 20) },       // 服务项目
          // 温馨提示只做提醒，不再捎带时段 —— 时段已经在服务日期里了，
          // 重复一遍既挤占 thing 的 20 字上限，读者也用不上。
          thing1: { value: clip('化妆完成，点击评价', 20) },
        },
      });
    }

    const slotDoc = slotDocs.get(b.date);
    if (slotDoc) {
      try {
        const data = nextStatus === 'rejected'
          ? { [`${b.slot}.booked`]: false, [`${b.slot}.done`]: false }
          : { [`${b.slot}.done`]: true };
        await db.collection('timeSlots').doc(slotDoc._id).update({ data });
      } catch (e) {
        console.warn('autoExpireOverdue 释放时段失败', b._id, e.message);
      }
    }
    return 1;
  }));

  const expired = results.reduce((a, n) => a + n, 0);
  if (expired) console.log(`autoExpireOverdue: 本次自动结算 ${expired} 条`);
  return { expired };
}

exports.main = async () => {
  return await autoExpireOverdue();
};
