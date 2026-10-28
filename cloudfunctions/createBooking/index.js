const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 每天3个时段
const SLOT_KEYS = ['morning', 'afternoon', 'evening'];

// ============ 时段配置 ============
// 时段的时间是数据不是代码：权威值在 timeSlots 集合的 _id='slot_times' 文档里。
//   { morning:{start,end}, afternoon:{...}, evening:{...},
//     overrides: { 'YYYY-MM-DD': { morning:{start,end} } } }
// 有效时间 = overrides[date][slot] ?? 全局的 slot（单日覆盖优先）。
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
    SLOT_KEYS.forEach(k => {
      const t = d[k];
      out[k] = (t && t.start && t.end) ? { start: t.start, end: t.end } : { ...DEFAULT_TIMES[k] };
    });
    return out;
  } catch (e) {
    return { ...DEFAULT_TIMES, overrides: {} };
  }
}

// 某一天某个时段的有效时间：单日覆盖优先，没有就用全局的
function effectiveTime(times, date, slot) {
  const ov = times.overrides[date] && times.overrides[date][slot];
  return (ov && ov.start && ov.end) ? ov : times[slot];
}

// 时间段字符串：'HH:MM-HH:MM'（**一个**连字符，订阅消息靠 split('-')[0] 取开始时间）
function rangeOf(t) {
  return `${t.start}-${t.end}`;
}

// 'HH:MM' → 从 00:00 起的分钟数
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

const MAX = { name: 20, skinType: 200, remark: 500, styleName: 20 };

// 想画的妆容照片：属于**单次预约**，最多 3 张，只写进 bookings，不进 users.info。
// 顾客每次想画的妆容大概率不同，所以每下一单都要重新传。
// 与 miniprogram/utils/profileInfo.js 的 MAX_STYLE_REF_PHOTOS 各抄一份
//（两个目录不共享文件系统，只能人工同步）。
const MAX_STYLE_REF_PHOTOS = 3;

// 只保留云存储 fileID，最多 MAX_STYLE_REF_PHOTOS 张。
// 口径与 userProfile 的 normalizePhotos 一致：不合法的静默丢弃、不报错。
function normalizeStyleRefPhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p) => String(p || '').trim())
    .filter((p) => p.indexOf('cloud://') === 0)
    .slice(0, MAX_STYLE_REF_PHOTOS);
}

// ============ 界面语言 ============
// 客户端每次调用都带 lang。不认识的一律中文 —— 老版本客户端不带这个字段，
// 老版本云函数也不认识它，两个方向的失败模式都是「显示中文」，不会出错。
function normalizeLang(l) {
  return l === 'en' ? 'en' : 'zh';
}

// 缺项字段名 → 英文标签。**只用于拼 message**：
// missing[] 数组本身必须保持中文（前端 utils/profileInfo.js 的规则要跟它对齐），
// 但 message 是给人看的，英文界面里蹦出中文字段名很露馅。
const FIELD_LABEL_EN = {
  '昵称': 'Nickname',
  '性别': 'Gender',
  '肤质': 'Skin Type',
  '敏感性程度': 'Sensitivity',
  '大面积爆痘': 'Severe Acne',
  '整容/医美': 'Surgery',
  '化妆品/发品过敏': 'Product Allergy',
  '过敏说明': 'Allergy Details',
  '素颜照': 'Bare-face Photo',
};

// 按仓库约定这里不共享模块，各抄一份。
const MSG = {
  zh: {
    badParams: '参数不完整',
    badDate: '日期格式不正确',
    badSlot: '无效时段',
    pastDate: '不能预约已过去的日期',
    slotExpired: (slot) => `该时段（${slot}）已过时，无法预约`,
    styleTooLong: (n) => `妆造名称不能超过 ${n} 个字`,
    nameRequired: '请填写姓名',
    nameTooLong: (n) => `昵称不能超过 ${n} 个字`,
    skinTooLong: (n) => `肤质描述不能超过 ${n} 个字`,
    remarkTooLong: (n) => `备注不能超过 ${n} 个字`,
    profileIncomplete: (list) => `请先补全个人信息：${list.join('、')}`,
    duplicated: '你已经预约过该时段，请勿重复提交',
    noSlotData: '未找到该日期的时段数据，请联系化妆师开启预约',
    slotNotOpen: (slot) => `该时段（${slot}）未开放预约`,
    styleGone: '所选妆造已不在该时段的开放列表中，请重新选择',
    styleRequired: '请选择要画的妆造',
    justBooked: (slot) => `该时段（${slot}）刚被预约，请刷新后重试`,
    ok: '预约提交成功，等待化妆师确认',
    serverError: (e) => '服务器错误：' + e,
  },
  en: {
    badParams: 'Missing parameters',
    badDate: 'Invalid date format',
    badSlot: 'Invalid time slot',
    pastDate: 'Cannot book a date in the past',
    slotExpired: (slot) => `This slot (${slot}) has already passed`,
    styleTooLong: (n) => `Style name cannot exceed ${n} characters`,
    nameRequired: 'Please enter a name',
    nameTooLong: (n) => `Nickname cannot exceed ${n} characters`,
    skinTooLong: (n) => `Skin description cannot exceed ${n} characters`,
    remarkTooLong: (n) => `Note cannot exceed ${n} characters`,
    profileIncomplete: (list) => `Please complete your profile: ${list.join(', ')}`,
    duplicated: 'You have already booked this slot',
    noSlotData: 'No schedule for this date — please ask the artist to open booking',
    slotNotOpen: (slot) => `This slot (${slot}) is not open for booking`,
    styleGone: 'That style is no longer available — please choose another one',
    styleRequired: 'Please choose a makeup style',
    justBooked: (slot) => `This slot (${slot}) was just booked — please refresh and retry`,
    ok: 'Booking submitted — waiting for the artist to confirm',
    serverError: (e) => 'Server error: ' + e,
  },
};

// ============ 订阅消息（按仓库约定各抄一份，不共享模块）============
// 模板 ID 在 公众平台 → 订阅消息 → 我的模板 申请后填写。
// 与 miniprogram/utils/notify.js 保持一致，改一处要改三处云函数。
const TPL_ARTIST_NEW = 'OE7Sj4rWPKUfCvreIfadWG5r3SPAmxGjgGGhJt9WG4E';  // 顾客新预约 → 化妆师

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

// 模板1的 time2 字段是「预约时间」，type 是 time，要带时分。
// 预约文档里存的是**区间**（'09:30-11:30'），整段塞进去会被平台判为非法，
// 所以只取开始时间。开始时间从下单那一刻的有效时间段里切出来（配置里的时间，
// 不是写死的常量），缺时段就退化成纯日期，仍然能发出去。
function fmtTime(date, slotName) {
  const start = String(slotName || '').split('-')[0] || '';
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

// 云函数运行时区不保证是东八区，统一按 UTC+8 计算「今天」和当前小时
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
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
  const { date, slot, name, skinType, remark, styleName, styleRefPhotos } = event;
  const lang = normalizeLang(event && event.lang);
  const msg = MSG[lang];
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
    return { success: false, message: msg.badParams };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, message: msg.badDate };
  }
  if (!SLOT_KEYS.includes(slot)) {
    return { success: false, message: msg.badSlot };
  }

  // 禁止预约过去的日期（服务端强校验，不依赖客户端时钟）
  if (date < todayStr(0)) {
    return { success: false, message: msg.pastDate };
  }

  // 禁止预约当天已过结束时刻的时段（如上午 10 点不能再约 09:30-11:30）。
  // 前端也会置灰，但客户端能绕过，必须服务端兜底。
  // 结束时刻来自配置（这一天的有效时间段），不再是写死的整数小时。
  const slotTimes = await readSlotTimes();
  const effTime = effectiveTime(slotTimes, date, slot);
  const slotRange = rangeOf(effTime);
  const now = beijingNow();
  const endMinutes = toMinutes(effTime.end);
  if (endMinutes !== null && date === now.date
      && now.hour * 60 + now.minute >= endMinutes) {
    return { success: false, message: msg.slotExpired(slotRange) };
  }

  const cleanName = String(name).trim();
  // 注意 || ''：客户端表单只传 name 和 styleName，skinType 缺失时
  // String(undefined) 会得到字面量 "undefined" 并落库（已修过的潜伏 bug）
  const cleanSkin = String(skinType || '').trim();
  const cleanRemark = String(remark || '').trim();
  const cleanStyleName = String(styleName || '').trim();
  // 想画的妆容照片（选填）：跟着这一单存，不写进个人资料
  const cleanStyleRefPhotos = normalizeStyleRefPhotos(styleRefPhotos);
  if (cleanStyleName.length > MAX.styleName) return { success: false, message: msg.styleTooLong(MAX.styleName) };
  if (!cleanName) return { success: false, message: msg.nameRequired };
  if (cleanName.length > MAX.name) return { success: false, message: msg.nameTooLong(MAX.name) };
  if (cleanSkin.length > MAX.skinType) return { success: false, message: msg.skinTooLong(MAX.skinType) };
  if (cleanRemark.length > MAX.remark) return { success: false, message: msg.remarkTooLong(MAX.remark) };

  // 个人信息必须完整（服务端强校验，与前端 utils/profileInfo.js 规则一致）
  const userDoc = await readUserDoc(openid);
  const missing = missingProfileFields(userDoc && userDoc.nickname, userDoc && userDoc.info);
  if (missing.length) {
    // missing[] 保持中文（前后端规则要一致），只把 message 里的字段名翻成英文
    const labels = lang === 'en' ? missing.map(m => FIELD_LABEL_EN[m] || m) : missing;
    return {
      success: false,
      code: 'PROFILE_INCOMPLETE',
      missing,
      message: msg.profileIncomplete(labels),
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
    return { success: false, message: msg.duplicated };
  }

  try {
    // 先确认该日期有时段配置，且目标时段存在
    const slotRes = await db.collection('timeSlots').where({ date }).limit(1).get();
    const slotDoc = slotRes.data && slotRes.data[0];
    if (!slotDoc) {
      return { success: false, message: msg.noSlotData };
    }
    const slotData = slotDoc[slot];
    if (!slotData || !slotData.open) {
      return { success: false, message: msg.slotNotOpen(slotRange) };
    }

    // 服务端校验所选妆造确实在该时段的开放列表中，价格以服务端配置为准
    const styleList = Array.isArray(slotData.styles) ? slotData.styles : [];
    let finalStyleName = '';
    let finalPrice = 0;
    if (cleanStyleName) {
      const matched = styleList.find(s => s && s.name === cleanStyleName);
      if (!matched) {
        return { success: false, message: msg.styleGone };
      }
      finalStyleName = matched.name;
      finalPrice = Number(matched.price) || 0;
    } else if (styleList.length > 0) {
      return { success: false, message: msg.styleRequired };
    }

    // 原子占用：条件更新（单文档更新本身是原子的），避免并发重复预约
    const claim = await db.collection('timeSlots').where({
      _id: slotDoc._id,
      [`${slot}.open`]: true,
      [`${slot}.booked`]: false,
    }).update({ data: { [`${slot}.booked`]: true, [`${slot}.done`]: false } });

    if (claim.stats.updated !== 1) {
      return { success: false, message: msg.justBooked(slotRange) };
    }

    let createRes;
    try {
      createRes = await db.collection('bookings').add({
        data: {
          _openid: openid,
          date,
          slot,
          // 下单那一刻的有效时间段（单日覆盖优先），通知里的预约时间从它切开始时间
          slotName: slotRange,
          name: cleanName,
          skinType: cleanSkin,
          remark: cleanRemark,
          styleName: finalStyleName,
          stylePrice: finalPrice,
          // 想画的妆容照片（fileID 数组，最多 3 张，选填）
          styleRefPhotos: cleanStyleRefPhotos,
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
        time2: { value: clip(fmtTime(date, slotRange), 32) },  // 预约时间
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
      message: msg.ok
    };
  } catch (err) {
    console.error('createBooking error:', err);
    return { success: false, message: msg.serverError(err.message) };
  }
};