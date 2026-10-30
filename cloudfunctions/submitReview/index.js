// submitReview - 顾客评价**自己某一单**已完成的服务
//
// 背景：化妆师在后台把预约标记成「已完成」之后，顾客端应该能给这次服务写一条评价。
// 评价**挂在预约文档上**（bookings.review），不另建 reviews 集合：
//   · listWeekSchedule（顾客端）和 adminGetBookings（后台）都返回整条预约文档，
//     review 会自动跟着回包走 —— 页面判断「有没有评价过」一次云函数调用都不用多打；
//   · 不用手动去云开发控制台建集合（users 集合当初就是因为这个坑过）。
// 一单一条评价：再次提交就是「修改」，服务端覆盖同一条记录。
//
// 身份只认 openid：cloud.getWXContext() 取，**绝不**从 event 里拿。
// 归属也在这里校验：doc._openid !== openid 一律拒绝。
//
// 首次评价之后会给化妆师发一条订阅消息（模板 E），告诉她有人评价了。
// 需要 config.json 里的 subscribeMessage.send 权限。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 评价正文最长字数。客户端 textarea 的 maxlength 也是 200，两边一致（服务端是硬约束）。
const MAX_REVIEW_LEN = 200;

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
// 顾客评价完 → 通知化妆师「有人评价了」。
// 与 miniprogram/utils/notify.js 保持一致，改一处要改所有发消息的云函数。
const TPL_ARTIST_REVIEW = 'ijQASAXFJ3se01cPLe1yQypcQcPJg7ea68xxLD_WcV0';  // 顾客评价 → 化妆师

// 联调期填 'developer'（走体验版），上线前改成 'formal'。
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

// 评价正文最长 200 字，但 thing 字段只吃 20 字 —— 截断成 19 字 + 一个省略号。
// 化妆师在通知里看到的是开头，完整内容在后台的「查看评价」里。
function clipReview(s) {
  const text = String(s == null ? '' : s);
  return text.length > 20 ? text.slice(0, 19) + '…' : text;
}

// 发订阅消息。永远不抛：43101（没订阅/额度用尽）是业务常态，不是异常。
// 调用方可以直接 await，失败只会拿到 false —— 评价流程毫发无损。
//
// ⚠️ 这个「永不抛」在**本文件**里更关键：main 整个被一个大 try/catch 包着，
// helper 一旦被换成裸的 cloud.openapi.subscribeMessage.send(...)，发送失败就会
// 冒泡进那个 catch，把一条**已经存成功的**评价报成「保存失败，请重试」，
// 顾客会以为没保存上，再点一次提交（内容已经写进去了，只是白跑一趟）。
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
    // users 集合必须手动在控制台建，不存在就是 -502005 —— 跳过发送，不阻断评价
    const text = [err && err.errMsg, err && err.message].filter(Boolean).join(' | ');
    console.warn('查询化妆师 openid 失败：', text);
    return [];
  }
}
// ================================================================

// ============ 界面语言 ============
// 客户端每次调用都带 lang。不认识的一律中文 —— 老版本客户端不带这个字段，
// 老版本云函数也不认识它，两个方向的失败模式都是「显示中文」，不会出错。
function normalizeLang(l) {
  return l === 'en' ? 'en' : 'zh';
}

// 按仓库约定这里不共享模块，各抄一份。
const MSG = {
  zh: {
    noIdentity: '服务端未获取到用户身份（openid 为空）。请确认微信开发者工具已登录微信账号，且本云函数已部署到小程序 app.js 配置的云环境。',
    badParams: '参数不完整',
    notFound: '预约不存在',
    notOwner: '无权评价该预约',
    notReviewable: '只有已完成的预约才能评价',
    emptyReview: '评价内容不能为空',
    tooLong: '评价最多 ' + MAX_REVIEW_LEN + ' 字',
    serverError: '保存失败，请重试',
  },
  en: {
    noIdentity: 'Server could not identify the user. Please make sure the DevTools is signed in and this function is deployed to the right cloud environment.',
    badParams: 'Missing parameters',
    notFound: 'Booking not found',
    notOwner: 'You are not allowed to review this booking',
    notReviewable: 'Only completed bookings can be reviewed',
    emptyReview: 'The review cannot be empty',
    tooLong: 'A review can be at most ' + MAX_REVIEW_LEN + ' characters',
    serverError: 'Save failed, please retry',
  },
};

exports.main = async (event, context) => {
  const msg = MSG[normalizeLang(event && event.lang)];
  const openid = currentOpenid(context);
  if (!openid) {
    console.error('submitReview: 未取到 openid');
    return { success: false, code: 'NO_OPENID', message: msg.noIdentity };
  }

  const bookingId = event && event.bookingId;
  if (!bookingId || typeof bookingId !== 'string') {
    return { success: false, message: msg.badParams };
  }

  const content = String((event && event.content) || '').trim();
  if (!content) {
    return { success: false, message: msg.emptyReview };
  }
  if (content.length > MAX_REVIEW_LEN) {
    return { success: false, message: msg.tooLong };
  }

  try {
    const res = await db.collection('bookings').doc(bookingId).get();
    const doc = res && res.data;
    if (!doc) return { success: false, message: msg.notFound };
    // 只能评价自己的预约
    if (doc._openid !== openid) return { success: false, message: msg.notOwner };
    // 只能评价已完成的单。前端只给「已完成」的卡片显示评价按钮，
    // 但那只是第一层 —— 服务端这道才是硬约束（状态可能刚被 sweepOverdue 改过）。
    if (doc.status !== 'completed') {
      return { success: false, message: msg.notReviewable };
    }

    // 改评价时保留第一次评价的时间，只刷 updateTime。
    //
    // 这里用普通的 Date 而不是 db.serverDate()：仓库里 db.serverDate() 一律只出现在
    // data 的顶层字段，嵌在对象里（review.createTime）能不能被服务端识别没有先例可循，
    // 不拿线上数据赌。值是在云函数里算的，本来就是服务端时间。
    // 存进去是日期类型，读回来是 Date 对象，adminPanel.formatDateTime() 直接能格式化。
    const now = new Date();
    const prev = (doc.review && typeof doc.review === 'object') ? doc.review : null;
    const review = {
      content,
      createTime: (prev && prev.createTime) || now,
      updateTime: now,
    };
    await db.collection('bookings').doc(bookingId).update({
      data: {
        review,
        updateTime: db.serverDate(),
      },
    });

    // 评价完成通知（模板 E → 化妆师）。
    //
    // 只有**第一次**评价才通知（prev 为空 = 这一单此前没有评价）：
    // 改评价不再发消息 —— 额度稀缺（1 次授权 = 1 条消息），而且化妆师在后台
    // 能看到最新内容，不需要为一次修改再打扰她。
    //
    // 位置在 update() 之后：评价已经落库，通知只是附带的。
    // sendSubscribeMessage 永不抛，findArtistOpenids 出错也只返回空数组，
    // 所以这里失败绝不会掉进下面那个大 catch、不会把成功的评价报成「保存失败」。
    //
    // 额度：化妆师在后台点「开启提醒」时一次授权拿到这 1 条。她没点过就收不到
    // 消息（43101），但评价照常存进库，后台能看到。
    if (!prev) {
      const artists = await findArtistOpenids();
      if (artists.length) {
        const data = {
          // key 与公众平台模板详情页一一对应，改模板要改这里
          thing3: { value: clip(doc.styleName || '化妆预约', 20) },  // 评价项目
          thing2: { value: clipReview(content) },                   // 评价内容（20 字上限，长的截断）
        };
        // 并发发给每一个 admin。sendSubscribeMessage 永不抛，所以其中一个人失败
        // （比如她从没授权过 → 43101）不影响其他人收到，也不会冒泡进外层 catch。
        await Promise.all(artists.map(touser => sendSubscribeMessage({
          touser,
          templateId: TPL_ARTIST_REVIEW,
          page: PAGE_HOME,
          data,
        })));
      }
    }

    // 只回传内容：客户端要做的只是把本地那一条补上 review.content，
    // 时间戳它用不上（后台那边是从库里原样读的），回传反而多一份要序列化的 Date。
    return { success: true, review: { content } };
  } catch (err) {
    const text = [err && err.errMsg, err && err.message].filter(Boolean).join(' | ');
    // 文档不存在：不是错误
    if (/-502003/.test(text) || /not exist/i.test(text)) {
      return { success: false, message: msg.notFound };
    }
    console.error('submitReview error:', err);
    return { success: false, message: msg.serverError };
  }
};
