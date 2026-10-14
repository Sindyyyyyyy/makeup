const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 兼容取 openid：优先官方 API cloud.getWXContext()，回退到 main 的 context 参数
function currentOpenid(context) {
  let wxCtx = {};
  try {
    wxCtx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
  } catch (e) {
    wxCtx = {};
  }
  return (wxCtx && wxCtx.OPENID) || (context && context.OPENID) || null;
}

// ============ 订阅消息（按仓库约定各抄一份，不共享模块）============
// 模板 ID 在 公众平台 → 订阅消息 → 我的模板 申请后填写。
// 与 miniprogram/utils/notify.js 保持一致，改一处要改三处云函数。
const TPL_ARTIST_CANCELLED = 'fBtVJqD7Ur_ERJ7y78L46MRXtX7n4R_SS4448hvqPIE';  // 顾客取消 → 化妆师

// 订阅消息卡片点开后打开哪个版本：
//   'trial'   测试期用这个 —— 体验成员随时能打开，长期有效
//   'formal'  正式上线前改成这个 —— 线上普通顾客只认这个
//   'developer' 只在开发者工具扫码时有效，几分钟就过期，点卡片会提示
//              「开发版小程序已过期」，所以不要用它给顾客测。
const MINI_STATE = 'trial';

// 与 createBooking 的 SLOT_NAMES 是同一份定义（改一处两处都要改）
const SLOT_NAMES = { morning: '09:30-11:30', afternoon: '14:00-17:00', evening: '18:00-21:00' };

const PAGE_HOME = 'pages/index/index'; // 无前导斜杠，须与 app.json 注册项逐字一致

// thing 类型上限 20 字，超了整条消息发不出去（47003）
function clip(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}

// 模板3 的 name1 字段是 **name 类型**，微信会严格校验「像不像人名」，
// 昵称带 emoji / 数字 / 英文 / 只有一个字，都会被判非法 → 47003 整条发不出去。
// 这里只保留汉字（含 · 和空格，阿拉伯/维吾尔族姓名用得到），
// 过滤后不足 2 字就退化成「顾客」——宁可信息粗一点，也不能让整条通知消失。
function fmtName(raw) {
  const s = String(raw == null ? '' : raw).replace(/[^一-龥·]/g, '').trim();
  return s.length >= 2 ? clip(s, 15) : '顾客';
}

// 模板3 的 time4 字段是「原预约时间」，type 是 time，要带时分。
// 时段文档里存的是**区间**（'09:30-11:30'），整段塞进去会被平台判为非法，
// 所以只取开始时间。开始时间直接从 SLOT_NAMES 切出来，不另抄常量；
// 缺时段就退化成纯日期，仍然能发出去。
function fmtTime(date, slot) {
  const start = (SLOT_NAMES[slot] || '').split('-')[0] || '';
  if (!start) return String(date || '');
  return `${date} ${start}:00`;
}

// 发订阅消息。永远不抛：43101（没订阅/额度用尽）是业务常态。
// 调用方可以直接 await，失败只拿到 false —— 取消流程毫发无损。
// ⚠️ 这个「永不抛」是刻意的结构性保证：本函数整个 main 被一个大 try/catch
// 包着，helper 一旦被换成裸的 cloud.openapi.subscribeMessage.send(...)，发送失败
// 就会冒泡进那个 catch，把一个**已经取消成功**的预约报成「服务器错误」。
// 排障入口是下面那两条日志（控制台 → 云函数 → cancelBooking → 日志 → 搜
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
    // 成功日志是故意留的：没有它无法区分「没触发」和「触发但被拒」
    console.log('subscribeMessage ok', templateId, JSON.stringify(res || {}));
    return true;
  } catch (err) {
    const code = (err && (err.errCode || err.errcode)) || '';
    const text = [err && err.errMsg, err && err.message].filter(Boolean).join(' | ');
    console.warn('subscribeMessage 跳过', 'code=' + code, 'touser=' + touser, text);
    return false;
  }
}

// 化妆师的 openid 列表：users.admin 是「谁是化妆师」的唯一真相来源，实时查而不是缓存 ——
// adminLogout 把 admin 置 false 后，缓存副本会继续给她发消息而 users.admin 不会。
// users 文档的 key 就是 openid 本身（doc(openid)），所以不需要额外的字段来记谁是谁。
//
// 返回**数组**而不是单个：可以有多个 admin（多个微信号都输过密码），
// 她们都要收到通知，所以这里不能 limit(1) —— 那会随机只通知其中一个。
async function findArtistOpenids() {
  try {
    const res = await db.collection('users')
      .where({ admin: true })
      .field({ _openid: true })
      .limit(100)   // 上限只是防呆；一个化妆师的助理数远小于 100
      .get();
    // 去重：万一集合里有 _openid 重复的脏数据，同一个人会收到两条
    const ids = (res.data || []).map(d => d && d._openid).filter(Boolean);
    return Array.from(new Set(ids));
  } catch (err) {
    // users 集合必须手动在控制台建，不存在就是 -502005 —— 跳过发送，不阻断取消
    const text = [err && err.errMsg, err && err.message].filter(Boolean).join(' | ');
    console.warn('查询化妆师 openid 失败：', text);
    return [];
  }
}
// ================================================================

exports.main = async (event, context) => {
  const { bookingId } = event;
  // openid 只能取自服务端，绝不接受客户端传入，否则可被伪造
  const openid = currentOpenid(context);

  if (!bookingId) {
    return { success: false, message: '缺少预约ID' };
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

    // 归属校验：任何人拿到 bookingId 都不能取消他人预约
    if (!openid) {
      console.error('cancelBooking: 未取到 openid, context keys =',
        JSON.stringify(Object.keys(context || {})));
      return {
        success: false,
        code: 'NO_OPENID',
        message: '服务端未获取到用户身份，无法校验预约归属。'
          + '请确认开发者工具已登录微信账号，且云函数已重新部署。',
      };
    }
    if (booking._openid !== openid) {
      return { success: false, message: '无权取消该预约' };
    }

    if (!['pending', 'confirmed'].includes(booking.status)) {
      return { success: false, message: '该预约当前状态不可取消' };
    }

    const updateRes = await db.collection('bookings').where({
      _id: bookingId,
      status: booking.status,
    }).update({
      data: {
        status: 'cancelled',
        updateTime: db.serverDate()
      }
    });
    if (updateRes.stats.updated === 0) {
      return { success: false, message: '操作失败，预约状态已变化，请刷新后重试' };
    }

    // 释放时段（只针对该日期的那一条记录）
    const slotRes = await db.collection('timeSlots').where({ date: booking.date }).limit(1).get();
    const slotDoc = slotRes.data && slotRes.data[0];
    if (slotDoc) {
      await db.collection('timeSlots').doc(slotDoc._id).update({
        data: { [`${booking.slot}.booked`]: false, [`${booking.slot}.done`]: false }
      });
    }

    // 通知化妆师（模板 C）：顾客主动取消了。
    // 释放时段**之后**才发：这样「时段已重新开放」是既成事实，化妆师看到通知时
    // 打开后台看到的就是真状态。
    //
    // ⚠️ 必须用 findArtistOpenids()，绝不能复用上面那个 openid 变量 —— 那是**顾客**
    // 的 openid，复用会把「取消通知」发给刚取消的那个人自己。
    const artists = await findArtistOpenids();
    if (artists.length) {
      // 多人共用同一份 data，只在 touser 上分叉 —— 字段拼装一次即可
      const data = {
        // key 与公众平台模板详情页一一对应，改模板要改这里
        name1: { value: fmtName(booking.name) },  // 姓名（必须是合法人名，见 fmtName）
        time4: { value: clip(fmtTime(booking.date, booking.slot), 32) },  // 原预约时间
        thing2: { value: clip(booking.styleName || '化妆预约', 20) },  // 原预约项目
        thing13: { value: clip('顾客主动取消，请重新开放时段', 20) },  // 温馨提醒
      };
      // 并发发给每一个 admin。sendSubscribeMessage 永不抛，所以其中一个人失败
      // （比如她从没授权过 → 43101）不影响其他人收到，也不会冒泡进外层 catch。
      await Promise.all(artists.map(touser => sendSubscribeMessage({
        touser,
        templateId: TPL_ARTIST_CANCELLED,
        page: PAGE_HOME,
        data,
      })));
    }

    // 返回值保持原样：不加任何字段把化妆师的 openid 带回客户端
    return { success: true, message: '预约已取消' };
  } catch (err) {
    console.error('cancelBooking error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};