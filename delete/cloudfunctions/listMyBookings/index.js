const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 已废弃，本目录已移到 delete/ 下——uploadCloudFunction.sh 只遍历 cloudfunctions/，
// 移出来就不会再被部署，也不会再占用代码里的调用额度。
//
// 新版小程序（pages/index）已经只调 listWeekSchedule 一个函数，它会一次返回
// 网格和「我的预约」卡片所需的全部数据。原来首页每次访问要并行调两个函数、
// 两次冷启动，而两个函数都跑一遍全表过期结算，是免费版 20 万次/月额度的主要消耗方。
//
// 云端那份函数仍然存在且可被调用，需要手动到云开发控制台删除。
// 删除前请确认没有旧版本小程序在调它——已发布出去的旧版本 pages/index
// 里仍写着 wx.cloud.callFunction({ name: 'listMyBookings' })，
// 微信的旧版本会一直存在到用户主动更新。确认无旧版本在跑后可连同本目录一起删除。
//
// 本文件保留的历史价值：早期版本首页要单独调它才能拿到「我的预约」卡片列表，
// 因为当时 listWeekSchedule 只返回本周的 4 个字段（_id/date/slot/status）。

const ACTIVE = ['pending', 'confirmed'];

exports.main = async (event, context) => {
  let wxCtx = {};
  try {
    wxCtx = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
  } catch (e) {}
  const openid = (wxCtx && wxCtx.OPENID) || (context && context.OPENID) || null;

  if (!openid) {
    return { success: false, code: 'NO_OPENID', message: '未获取到用户身份' };
  }

  try {
    const res = await db.collection('bookings')
      .where({ _openid: openid })
      // 只按日期倒序取；同一天内的时段先后（晚上→下午→上午）由客户端按
      // SLOT_ORDER 排，数据库 orderBy('slot') 是字母序，顺序不对
      .orderBy('date', 'desc')
      .limit(50)
      .get();

    return { success: true, data: res.data };
  } catch (err) {
    console.error('listMyBookings error:', err);
    return { success: false, message: err.message };
  }
};