const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const SLOT_KEYS = ['morning', 'afternoon', 'evening'];

// 状态机：仅允许的流转
const ACTION_MAP = {
  confirm: { from: ['pending'], to: 'confirmed' },
  reject: { from: ['pending'], to: 'rejected' },
  complete: { from: ['confirmed'], to: 'completed' },
};

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

// ============ 订阅消息（按仓库约定各抄一份，不共享模块）============
// 模板 ID 在 公众平台 → 订阅消息 → 我的模板 申请后填写。
// 与 miniprogram/utils/notify.js 保持一致，改一处要改所有发消息的云函数。
const TPL_CUSTOMER_RESULT = 'L-Esvcae2XxxhLhogHY0dP5d_NUCpOw4rEcBNZB4u3A';  // 确认/拒绝 → 顾客
const TPL_CUSTOMER_REVIEW = '7nqJY8IDCfQQ0n69vum6opcRmFlCV2XVEYJVpX0d8PY'; // 标记完成 → 顾客（提醒评价）

// 联调期填 'developer'（走体验版），上线前改成 'formal'。
// 用 'formal' 时 page 必须是已发布版本里存在的页面，否则 41030。
// 订阅消息卡片点开后打开哪个版本：
//   'trial'   测试期用这个 —— 体验成员随时能打开，长期有效
//   'formal'  正式上线前改成这个 —— 线上普通顾客只认这个
//   'developer' 只在开发者工具扫码时有效，几分钟就过期，点卡片会提示
//              「开发版小程序已过期」，所以不要用它给顾客测。
const MINI_STATE = 'trial';

const PAGE_HOME = 'pages/index/index'; // 无前导斜杠，须与 app.json 注册项逐字一致

// thing 类型上限 20 字，超了整个消息发不出去（47003）
function clip(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}

// date2 / date6 都是 date 类型字段：微信接受 '2026-10-20 09:30:00' 这种带时分的
// 格式，所以「预约时间」「服务日期」一个字段就同时表达了日期和具体时段，
// 不用另加一个「时段」字段。
// 时段从预约文档自带的 slotName（'09:30-11:30'）里切出开始时间 —— 用文档里的值
// 而不是另抄一份 SLOT_NAMES，这样时段定义改了这里自动跟着变；slotName 缺失时
// 退化成纯日期，仍然能发出去。
//
// ⚠️ **只取开始时间，不要把整段区间塞进去**：
//   '2026-10-30 09:30-11:30'（连字符）会被判非法 → 整条消息 47003 发不出去，
//   顾客不是「看不到时段」，而是连卡片都收不到。
//   平台认可的区间写法是 'YYYY-MM-DD HH:mm:ss~YYYY-MM-DD HH:mm:ss'（分隔符 '~'，
//   两端都带完整日期时间），但那在卡片上很长，本次统一用开始时间。
function fmtDateTime(date, slotName) {
  const start = String(slotName || '').split('-')[0] || '';
  if (!start) return String(date || '');
  return `${date} ${start}:00`;
}

// 发订阅消息。永远不抛：43101（没订阅/额度用尽）是业务常态，不是异常。
// 调用方可以直接 await，失败只会拿到 false —— 预约流程毫发无损。
//
// ⚠️ 这个「永不抛」是刻意的结构性保证，不是偷懒：本文件整个 main 被一个大
// try/catch 包着，helper 一旦被换成裸的 cloud.openapi.subscribeMessage.send(...)，
// 发送失败就会冒泡进那个 catch，把一个**已经成功的**确认变成「服务器错误」，
// 化妆师会以为失败又点一次（第二次被状态机挡住，状态其实早就改了）。
//
// 常见错误码：
//   43101 未订阅/额度用尽（最常见，不用管）· 47003 模板参数不准确（字段名对不上）
//   47004 缺少模板参数 · 47006 模板参数为空 · 40037 模板 ID 错或被删
//   41030 page 路径不正确 · -501001 config.json 权限没生效/环境不对
// 运行时只 catch，不要按 errCode 分支：分支越多越容易有人后来加「重试」，
// 而重试会消耗额度并放大延迟。排障入口是下面这条日志。
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

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  const { bookingId, action } = event;

  if (!bookingId || !action) {
    return { success: false, message: '参数不完整' };
  }
  const rule = ACTION_MAP[action];
  if (!rule) {
    return { success: false, message: '无效操作' };
  }

  try {
    let bookingRes;
    try {
      bookingRes = await db.collection('bookings').doc(bookingId).get();
    } catch (e) {
      return { success: false, message: '预约不存在' };
    }
    const booking = bookingRes.data;
    if (!booking) {
      return { success: false, message: '预约不存在' };
    }

    // 状态机校验：防止对已取消/已拒绝的预约重复操作
    if (!rule.from.includes(booking.status)) {
      return { success: false, message: `当前状态不可执行该操作（${booking.status}）` };
    }

    const updateRes = await db.collection('bookings').where({
      _id: bookingId,
      status: booking.status,
    }).update({
      data: {
        status: rule.to,
        updateTime: db.serverDate()
      }
    });
    if (updateRes.stats.updated === 0) {
      return { success: false, message: '操作失败，预约状态已变化，请刷新后重试' };
    }

    // 仅拒绝时释放时段；完成只做归档，保留占用记录以便追溯。
    // 完成时额外打上 done 标记，时段管理页据此显示「已完成」而不是「已预约」
    if (rule.to === 'rejected' || rule.to === 'completed') {
      const slotRes = await db.collection('timeSlots').where({ date: booking.date }).limit(1).get();
      const slotDoc = slotRes.data && slotRes.data[0];
      if (slotDoc) {
        const data = rule.to === 'rejected'
          ? { [`${booking.slot}.booked`]: false, [`${booking.slot}.done`]: false }
          : { [`${booking.slot}.done`]: true };
        await db.collection('timeSlots').doc(slotDoc._id).update({ data });
      }
    }

    // 预约结果通知（模板 A → 顾客）：只有「确认」和「拒绝」要通知。
    //
    // 位置讲究：
    //   · 必须在上面的 CAS 更新之后 —— 更新失败时那条 return 已经返回了，
    //     也就不会发出「已确认」却其实没确认的假消息。
    //   · 必须在 return 之前 —— 预约事实已经落库，消息只是附带的。
    //   · sendSubscribeMessage 内部吞掉全部异常，所以这里即使发送失败，也不会
    //     掉进下面那个大 catch、不会把成功变成 {success:false}。
    //
    // 额度：ACTION_MAP 里 confirm 和 reject 的 from 都只有 'pending'，确认后
    // 再点拒绝会被状态机挡掉，所以一次预约生命周期内这个模板最多触发一次，
    // 与顾客下单时的那一次授权精确匹配。
    if (rule.to === 'confirmed' || rule.to === 'rejected') {
      await sendSubscribeMessage({
        touser: booking._openid,   // 预约文档自己记着顾客的 openid
        templateId: TPL_CUSTOMER_RESULT,
        page: PAGE_HOME,
        data: {
          // key 与公众平台模板详情页一一对应，改模板要改这里
          date2: { value: clip(fmtDateTime(booking.date, booking.slotName), 32) },  // 预约时间
          thing3: { value: clip(booking.styleName || '化妆预约', 20) },  // 预约项目
          // phrase 类型：纯中文且 ≤5 字，「已确认」「已拒绝」都满足
          phrase5: { value: rule.to === 'confirmed' ? '已确认' : '已拒绝' },  // 预约结果
          // 温馨提示按结果给不同文案。两条都 ≤20 字（11 / 19），塞得进 thing 上限。
          // 确认/拒绝在这里一次性分派 —— 拒绝时顾客拿不到任何解释，所以文案里
          // 指明要主动联系化妆师。
          thing6: {
            value: rule.to === 'confirmed'
              ? clip('预约已确认，请准时到店', 20)
              : clip('化妆师临时有事，具体原因请与化妆师联系', 20),
          },
        },
      });
    }

    // 「标记完成」提醒顾客评价（模板 D → 顾客）。
    //
    // 位置与上面那条一致：CAS 更新成功之后才发，所以不会出现「其实没完成却收到
    // 提醒」。sendSubscribeMessage 永不抛，发送失败不会掉进下面那个大 catch，
    // 化妆师看到的仍然是「已标记完成」。
    //
    // 额度：顾客下单时一次授权拿到这 1 条，一次预约对应一条提醒，正好对上。
    // 顾客没授权（老单 / 当次点了拒绝）时发不出去（43101），业务毫发无损 ——
    // 那种单顾客只能自己刷首页才看到「评价」按钮。
    //
    // ⚠️ 手动「标记完成」和 sweepOverdue 定时自动完成发的是**同一个模板**，
    // 两条路径互斥：两边都用带 status 条件的 CAS 改状态，只有改成功的那一方
    // 会发消息，所以一单最多发出去一条提醒，正好对上顾客下单时那 1 次授权。
    // （sweepOverdue 的 config.json 因此也开了 subscribeMessage.send 权限。）
    if (rule.to === 'completed') {
      await sendSubscribeMessage({
        touser: booking._openid,   // 预约文档自己记着顾客的 openid
        templateId: TPL_CUSTOMER_REVIEW,
        page: PAGE_HOME,
        data: {
          // key 与公众平台模板详情页一一对应，改模板要改这里
          //
          // 服务日期带上这一单的开始时间（'2026-10-30 09:30:00'），
          // 顾客一眼看到是哪一场；跟 date2/time2/time4 同一写法，平台认。
          // 不要写整段区间（'2026-10-30 09:30-11:30'）—— 那会被判非法，
          // 整条消息 47003 发不出去。详见上面 fmtDateTime 的注释。
          date6: { value: clip(fmtDateTime(booking.date, booking.slotName), 32) },  // 服务日期
          thing3: { value: clip(booking.styleName || '化妆预约', 20) },  // 服务项目
          // 温馨提示只做提醒，不再捎带时段 —— 时段已经在服务日期里了，
          // 重复一遍既挤占 thing 的 20 字上限，读者也用不上。
          thing1: { value: clip('化妆完成，点击评价', 20) },
        },
      });
    }

    const messages = { confirmed: '已确认预约', rejected: '已拒绝预约', completed: '已标记完成' };
    // 把落库后的新状态一并回传：客户端据此就地改那一条记录，
    // 不必为了一个状态翻转再全量重拉整页预约（省一次云函数调用 + 50 条文档过桥）
    return { success: true, message: messages[rule.to], status: rule.to };
  } catch (err) {
    console.error('adminUpdateBooking error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};