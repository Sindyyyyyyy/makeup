const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const SLOT_KEYS = ['morning', 'afternoon', 'evening'];

// ============ 时段配置 ============
// 权威值在 timeSlots 集合的 _id='slot_times' 文档里：
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

// 某一天某个时段的有效时间段（'HH:MM-HH:MM'）
function effectiveRange(times, date, slot) {
  const day = times && times.overrides && times.overrides[date];
  const ov = day && day[slot];
  const t = (ov && ov.start && ov.end) ? ov : times[slot];
  return `${t.start}-${t.end}`;
}

// 妆造（样式）校验：名称 ≤ 20 字，价格 0~99999 元
const MAX_STYLE_NAME = 20;
const MAX_STYLE_COUNT = 10;
const MAX_PRICE = 99999;

function normalizeStyles(styles) {
  if (!Array.isArray(styles)) return null;
  if (styles.length > MAX_STYLE_COUNT) {
    return { error: `妆造最多添加 ${MAX_STYLE_COUNT} 个` };
  }
  const clean = [];
  for (const s of styles) {
    const name = String((s && s.name) || '').trim();
    if (!name) return { error: '妆造名称不能为空' };
    if (name.length > MAX_STYLE_NAME) return { error: `妆造名称不能超过 ${MAX_STYLE_NAME} 个字` };

    const rawPrice = typeof s.price === 'number' ? s.price : Number(String((s && s.price) || '').trim());
    if (!isFinite(rawPrice) || isNaN(rawPrice)) return { error: `妆造「${name}」的价格无效` };
    if (rawPrice < 0) return { error: `妆造「${name}」的价格不能为负` };
    if (rawPrice > MAX_PRICE) return { error: `妆造「${name}」的价格不能超过 ${MAX_PRICE} 元` };

    clean.push({ name, price: Math.round(rawPrice * 100) / 100 });
  }
  const names = clean.map(s => s.name);
  if (new Set(names).size !== names.length) return { error: '妆造名称不能重复' };
  return { styles: clean };
}

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

exports.main = async (event) => {
  if (!verifyAdmin(event)) {
    return { success: false, message: '权限验证失败，请重新登录', code: 'UNAUTHORIZED' };
  }

  const { date, slot, action, styles } = event;

  if (!date || !slot || !action) {
    return { success: false, message: '参数不完整' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, message: '日期格式不正确' };
  }
  if (!SLOT_KEYS.includes(slot)) {
    return { success: false, message: '无效时段' };
  }
  if (!['open', 'close'].includes(action)) {
    return { success: false, message: '无效操作' };
  }

  // styles 仅在开放时下发；传了就必须合法且至少一个
  let cleanStyles = null;
  if (styles !== undefined && styles !== null) {
    const parsed = normalizeStyles(styles);
    if (parsed.error) return { success: false, message: parsed.error };
    cleanStyles = parsed.styles;
    if (action === 'open' && cleanStyles.length === 0) {
      return { success: false, message: '请至少添加一个可画的妆造' };
    }
  }

  try {
    const open = action === 'open';
    let finalSlot = null;   // 写完之后这个时段的真实状态，回传给客户端打补丁

    // 提示文案里的时间段用「这一天的有效时间段」（单日覆盖优先），不是写死的那张表
    const slotRange = effectiveRange(await readSlotTimes(), date, slot);

    // 查找是否已有该日期记录
    const existing = await db.collection('timeSlots').where({ date }).limit(1).get();
    const record = existing.data && existing.data[0];

    if (record) {
      const current = record[slot] || {};
      const isBooked = !!current.booked;

      // 关闭时若该时段仍有预约，释放 booked 会造成重复预约，必须拦截
      if (!open && isBooked) {
        return {
          success: false,
          message: `该时段（${slotRange}）已有预约，请先在预约列表中取消或拒绝后再关闭`,
        };
      }

      // 已有预约时该时段已对顾客可见，妆造不可再增删改，否则已下单顾客看到的
      // 妆造/价格会与实际约定不符
      if (open && isBooked && cleanStyles) {
        return {
          success: false,
          message: `该时段（${slotRange}）已有预约，不能再修改妆造。如需调整，请先取消或拒绝该预约`,
        };
      }

      await db.collection('timeSlots').doc(record._id).update({
        data: {
          [`${slot}.open`]: open,
          // 关闭时段时保留已配置的妆造，方便下次开放直接复用
          ...(cleanStyles ? { [`${slot}.styles`]: cleanStyles } : {}),
          ...(open ? {} : { [`${slot}.booked`]: false }),
        }
      });

      // 写完之后这个时段的真实状态。回传它，客户端就能就地更新那一个格子，
      // 不必为了验证「妆造到底有没有落库」再把整周时段表重拉一遍。
      finalSlot = {
        open,
        booked: open ? isBooked : false,
        done: !!current.done,
        // 没传 styles 时保持原样——「只开关时段不改妆造」是合法操作
        styles: cleanStyles || (Array.isArray(current.styles) ? current.styles : []),
      };
    } else {
      // 新建：其余时段默认关闭
      const initData = {
        date,
        morning: { open: false, booked: false, done: false },
        afternoon: { open: false, booked: false, done: false },
        evening: { open: false, booked: false, done: false }
      };
      initData[slot] = { open, booked: false, done: false, ...(cleanStyles ? { styles: cleanStyles } : {}) };
      await db.collection('timeSlots').add({ data: initData });

      finalSlot = {
        open,
        booked: false,
        done: false,
        styles: cleanStyles || [],
      };
    }

    const msg = open
      ? `已开放 ${slotRange} 预约`
      : `已关闭 ${slotRange} 预约`;
    return { success: true, message: msg, date, slot, slotState: finalSlot };
  } catch (err) {
    console.error('adminSetTimeSlot error:', err);
    return { success: false, message: '服务器错误：' + err.message };
  }
};