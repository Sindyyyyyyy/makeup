const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTION = 'users';

// 后台右上角「退出」用：撤销调用者自己的化妆师身份，下次进入要重新输密码。
//
// 两条设计约束：
// 1. 目标 openid 一律取自 getWXContext()，绝不从 event 读 —— 所以这个接口
//    不存在越权撤销别人身份的可能。
// 2. 不校验令牌，而且这是刻意的：令牌 7 天过期后如果还要求令牌，这里会失败、
//    客户端照常清掉本地状态，而 users.admin 留在 true —— 退出就成了假动作，
//    下次点「化妆师入口」又被静默送回后台。
//    不校验并不构成提权风险：这是严格的自我降权，未认证调用者最坏只能清一个
//    不属于自己的标记（空操作）。

function getOpenid(context) {
  let openid = null;
  try {
    const wxCtx = cloud.getWXContext();
    openid = (wxCtx && wxCtx.OPENID) || null;
  } catch (e) {
    openid = null;
  }
  if (!openid && context) openid = context.OPENID || null;
  return openid;
}

function errText(err) {
  if (!err) return '';
  return [err.errMsg, err.message, err.stack].filter(Boolean).join(' | ');
}

function isMissingCollection(err) {
  const text = errText(err);
  if (err && err.errCode === -502005) return true;
  return /collection[\s.]*not[\s.]*exist|collection.*does not exist|-502005/i.test(text);
}

function isMissingDoc(err) {
  const text = errText(err);
  if (err && err.errCode === -502003) return true;
  return /document.*(not|no).*exist|-502003/i.test(text);
}

exports.main = async (event, context) => {
  const openid = getOpenid(context);
  if (!openid) {
    // 拿不到身份就没什么可撤销的，当作成功，让客户端照常清本地
    return { success: true, skipped: true, message: '未取到用户身份' };
  }

  try {
    const ref = db.collection(COLLECTION).doc(openid);
    try {
      await ref.update({ data: { admin: false, adminUpdateTime: db.serverDate() } });
      return { success: true };
    } catch (err) {
      // 从没登录过 / 集合没建：本来就不是化妆师，幂等成功
      if (isMissingCollection(err) || isMissingDoc(err)) {
        return { success: true, skipped: true };
      }
      throw err;
    }
  } catch (err) {
    console.error('adminLogout error:', errText(err) || err);
    return { success: false, code: 'SERVER_ERROR', message: '服务器错误：' + err.message };
  }
};