const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 每天3个时段
const SLOT_KEYS = ['morning', 'afternoon', 'evening'];
const SLOT_NAMES = { morning: '09:30-11:30', afternoon: '14:00-17:00', evening: '18:00-21:00' };

const MAX = { name: 20, skinType: 200, remark: 500, styleName: 20 };

// ============ 订阅消息（按仓库约定各抄一份，不共享模块）============
// 模板 ID 在 公众平台 → 订阅消息 → 我的模板 申请后填写。
// 与 miniprogram/utils/notify.js 保持一致，改一处要改三处云函数。
const TPL_ARTIST_NEW = 'OE7Sj4rWPKUfCvreIfadWG5r3SPAmxGjgGGhJt9WG4E';  // 顾客新预约 → 化妆师

// 联调期填 'developer'（走体验版），上线前改成 'formal' 并重新部署。
const MINI_STATE = 'developer';

const PAGE_HOME = 'pages/index/index'; // 无前导斜杠，须与 app.json 注册项逐字一致

// thing 类型上限 20 字，超了整条消息发不出去（47003）
function clip(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}

// 模板1的 time2 字段是「预约时间」，type 是 time，要带时分。
// 时段文档里存的是**区间**（'09:30-11:30'），整段塞进去会被平台判为非法，
// 所以只取开始时间。开始时间直接从 SLOT_NAMES 切出来，不另抄一份常量，
// 改时段定义时自动跟着变。缺时段就退化成纯日期，仍然能发出去。
function fmtTime(date, slot) {
  const start = (SLOT_NAMES[slot] || '').split('-')[0] || '';
  if (!start) return String(date || '');
  return `${date} ${start}:00`;
}

// 发订阅消息。永远不抛：43101（没订阅/额度用尽）是业务常态。
// 调用方可以直接 await，失败只拿到 false —— 下单流程毫发无损。
// ⚠️ 这个「永不抛」是刻意的结构性保证：本函数整个 main 被一个大 try/catch
// 包着（下面还有 add() 失败要回滚时段占用的 rethrow），helper 一旦被换成裸的
// cloud.openapi.subscribeMessage.send(...)，发送失败就会冒泡进那个 catch，
// 把一条**已经下单成功**的预约报成「服务器错误」。
// 排障入口是下面那两条日志（控制台 → 云函数 → createBooking → 日志 → 搜
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

// 化妆师的 openid 列表：users.admin 是「谁是化妆师」的唯一真相来源，
// 实时查而不是缓存 —— adminLogout 把 admin 置 false 后，缓存副本会继续给她发消息
// 而 users.admin 不会。users 文档的 key 就是 openid 本身（doc(openid)），
// 不需要额外字段来记谁是谁。
//
// 返回**数组**而不是单个：可以有多个 admin（多个微信号都输过密码），
// 她们都要收到通知，所以这里不能 limit(1) —— 那会随机只通知其中一个。
async function findArtistOpenids() {
  try {
    const res = await db.collection('users')
      .where({ admin: true })
      .field({ _openid: true })
      .limit(100)   // 上限只是防呆；一个理发店的化妆师数远小于 100
      .get();
    // 去重：万一集合里有 _openid 重复的脏数据，同一个人会收到两条
    const ids = (res.data || []).map(d => d && d._openid).filter(Boolean);
    return Array.from(new Set(ids));
  } catch (err) {
    // users 集合必须手动在控制台建，不存在就是 -502005 —— 跳过发送，不阻断下单
    const text = [err && err.errMsg, err && err.message].filter(Boolean).join(' | ');
    console.warn('查询化妆师 openid 失败：', text);
    return [];
  }
}
// ================================================================

// 预约前置条件：个人信息必须填写完整。
// 前端同样有一份规则（miniprogram/utils/profileInfo.js），两边都要改。
// 这里必须有：只靠前端校验等于没有校验，客户端能绕过。
// 签名只收 nickname 与 info，不收整个文档——避免把文档当 info 传进来那种错法。
function missingProfileFields(nickname, info) {
  const i = info || {};
  const missing = [];
  if (!nickname) missing.push('昵称');
  if (!i.gender) missing.push('性别');
  if (!i.skinType) missing.push('肤质');
  if (i.skinType === '敏感性' && !i.sensitiveLevel) missing.push('敏感性程度');
  if (!i.hasAcne) missing.push('大面积爆痘');
  if (!i.hasCosmeticSurgery) missing.push('整容/医美');
  if (!i.hasAllergy) missing.push('化妆品/发品过敏');
  if (i.hasAllergy === '有' && !i.allergyNote) missing.push('过敏说明');
  if (!Array.isArray(i.photos) || i.photos.length < 1) missing.push('素颜照');
  return missing;
}

// 读本人资料；集合或文档不存在时返回 null（区别于“没取到身份”）
async function readUserDoc(openid) {
  try {
    const res = await db.collection('users').doc(openid).get();
    return res.data || null;
  } catch (err) {
    const text = [err.errMsg, err.message].filter(Boolean).join(' | ');
    // 集合/文档不存在都按“没有资料”处理，交给上层报缺项
    if (/-502005|-502003/.test(text) || /not exist/i.test(text)) return null;
    throw err;
  }
}

// 时段结束时刻（本地 24 小时制）：上午 11 点后 / 下午 17 点后 / 晚上 21 点后
// 与前端 utils/slots.js 的 SLOT_END_HOUR 是同一套规则，改一处要改两处
const SLOT_END_HOUR = { morning: 11, afternoon: 17, evening: 21 };

// 云函数运行时区不保证是东八区，统一按 UTC+8 计算「今天」和当前小时
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    hour: d.getUTCHours(),
  };
}

function todayStr(offsetDays) {
  const now = beijingNow();
  const [y, m, d] = now.date.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  if (offsetDays) base.setUTCDate(base.getUTCDate() + offsetDays);
  const p = n => String(n).padStart(2, '0');
  return `${base.getUTCFullYear()}-${p(base.getUTCMonth() + 1)}-${p(base.getUTCDate())}`;
}

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

exports.main = async (event, context) => {
  const { date, slot, name, skinType, remark, styleName } = event;
  const openid = currentOpenid(context);

  // 顾客端不再需要密码，身份由 openid 决定
  if (!openid) {
    let wxCtx = {};
    try {
      wxCtx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
    } catch (e) {}
    console.error('createBooking: 未取到 openid',
      '| cloud.getWXContext() =', JSON.stringify(wxCtx),
      '| context keys =', JSON.stringify(Object.keys(context || {})));
    return {
      success: false,
      code: 'NO_OPENID',
      message: '服务端未获取到用户身份（openid 为空）。'
        + '请确认：①微信开发者工具右上角已登录微信账号；'
        + '②本云函数已重新部署到小程序 app.js 中配置的那个云环境。',
    };
  }

  if (!date || !slot || !name) {
    return { success: false, message: '参数不完整' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, message: '日期格式不正确' };
  }
  if (!SLOT_KEYS.includes(slot)) {
    return { success: false, message: '无效时段' };
  }

  // 禁止预约过去的日期（服务端强校验，不依赖客户端时钟）
  if (date < todayStr(0)) {
    return { success: false, message: '不能预约已过去的日期' };
  }

  // 禁止预约当天已过结束时刻的时段（如上午 10 点不能再约 09:30-11:30）。
  // 前端也会置灰，但客户端能绕过，必须服务端兜底。
  const now = beijingNow();
  const endHour = SLOT_END_HOUR[slot];
  if (endHour !== undefined && date === now.date && now.hour >= endHour) {
    return { success: false, message: `该时段（${SLOT_NAMES[slot]}）已过时，无法预约` };
  }

  const cleanName = String(name).trim();
  // 注意 || ''：客户端表单只传 name 和 styleName，skinType 缺失时
  // String(undefined) 会得到字面量 "undefined" 并落库（已修过的潜伏 bug）
  const cleanSkin = String(skinType || '').trim();
  const cleanRemark = String(remark || '').trim();
  const cleanStyleName = String(styleName || '').trim();
  if (cleanStyleName.length > MAX.styleName) return { success: false, message: `妆造名称不能超过 ${MAX.styleName} 个字` };
  if (!cleanName) return { success: false, message: '请填写姓名' };
  if (cleanName.length > MAX.name) return { success: false, message: `昵称不能超过 ${MAX.name} 个字` };
  if (cleanSkin.length > MAX.skinType) return { success: false, message: `肤质描述不能超过 ${MAX.skinType} 个字` };
  if (cleanRemark.length > MAX.remark) return { success: false, message: `备注不能超过 ${MAX.remark} 个字` };

  // 个人信息必须完整（服务端强校验，与前端 utils/profileInfo.js 规则一致）
  const userDoc = await readUserDoc(openid);
  const missing = missingProfileFields(userDoc && userDoc.nickname, userDoc && userDoc.info);
  if (missing.length) {
    return {
      success: false,
      code: 'PROFILE_INCOMPLETE',
      missing,
      message: `请先补全个人信息：${missing.join('、')}`,
    };
  }

  // 同一时段不允许重复预约（pending / confirmed 都算占用）
  const dup = await db.collection('bookings').where({
    _openid: openid,
    date,
    slot,
    status: db.command.in(['pending', 'confirmed']),
  }).limit(1).get();
  if (dup.data && dup.data.length > 0) {
    return { success: false, message: '你已经预约过该时段，请勿重复提交' };
  }

  try {
    // 先确认该日期有时段配置，且目标时段存在
    const slotRes = await db.collection('timeSlots').where({ date }).limit(1).get();
    const slotDoc = slotRes.data && slotRes.data[0];
    if (!slotDoc) {
      return { success: false, message: '未找到该日期的时段数据，请联系化妆师开启预约' };
    }
    const slotData = slotDoc[slot];
    if (!slotData || !slotData.open) {
      return { success: false, message: `该时段（${SLOT_NAMES[slot]}）未开放预约` };
    }

    // 服务端校验所选妆造确实在该时段的开放列表中，价格以服务端配置为准
    const styleList = Array.isArray(slotData.styles) ? slotData.styles : [];
    let finalStyleName = '';
    let finalPrice = 0;
    if (cleanStyleName) {
      const matched = styleList.find(s => s && s.name === cleanStyleName);
      if (!matched) {
        return { success: false, message: '所选妆造已不在该时段的开放列表中，请重新选择' };
      }
      finalStyleName = matched.name;
      finalPrice = Number(matched.price) || 0;
    } else if (styleList.length > 0) {
      return { success: false, message: '请选择要画的妆造' };
    }

    // 原子占用：条件更新（单文档更新本身是原子的），避免并发重复预约
    const claim = await db.collection('timeSlots').where({
      _id: slotDoc._id,
      [`${slot}.open`]: true,
      [`${slot}.booked`]: false,
    }).update({ data: { [`${slot}.booked`]: true, [`${slot}.done`]: false } });

    if (claim.stats.updated !== 1) {
      return { success: false, message: `该时段（${SLOT_NAMES[slot]}）刚被预约，请刷新后重试` };
    }

    let createRes;
    try {
      createRes = await db.collection('bookings').add({
        data: {
          _openid: openid,
          date,
          slot,
          slotName: SLOT_NAMES[slot],
          name: cleanName,
          skinType: cleanSkin,
          remark: cleanRemark,
          styleName: finalStyleName,
          stylePrice: finalPrice,
          status: 'pending',
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
      });
    } catch (addErr) {
      // 写入失败必须回滚占用，否则时段被永久锁死
      await db.collection('timeSlots').doc(slotDoc._id).update({
        data: { [`${slot}.booked`]: false }
      });
      throw addErr;
    }

    // 新预约提醒（模板 B → 化妆师）。
    //
    // 位置：在 add() 成功**之后**发 —— 预约已落库，通知只是附带的；发送失败也绝
    // 不能回滚时段占用（下面那个 catch 里的回滚逻辑因此保持原样、零风险）。
    // sendSubscribeMessage 内部吞掉全部异常，这里失败也只会拿到 false。
    //
    // 额度：每次点「开启」+1，化妆师点几次就顶几次。顾客每次下单授权的是
    // 「化妆师通过／拒绝」模板，与本模板互不干扰。
    const artists = await findArtistOpenids();
    if (artists.length) {
      // 多人共用同一份 data，只在 touser 上分叉 —— 字段拼装一次即可
      const data = {
        // key 与公众平台模板详情页一一对应，改模板要改这里
        thing20: { value: clip(cleanName, 20) },  // 预约人
        time2: { value: clip(fmtTime(date, slot), 32) },  // 预约时间
        thing7: { value: clip(finalStyleName || '化妆预约', 20) },  // 预约项目
        thing9: { value: clip('新预约待确认，请及时处理', 20) },  // 温馨提示
      };
      // 并发发给每一个 admin。sendSubscribeMessage 永不抛，所以其中一个人失败
      // （比如她从没授权过 → 43101）不影响其他人收到，也不会冒泡进外层 catch。
      await Promise.all(artists.map(touser => sendSubscribeMessage({
        touser,
        templateId: TPL_ARTIST_NEW,
        page: PAGE_HOME,
        data,
      })));
    }

    return {
      success: true,
      bookingId: createRes._id,
      message: '预约提交成功，等待化妆师确认'
    };
  } catch (err) {
    console.error('createBooking error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};