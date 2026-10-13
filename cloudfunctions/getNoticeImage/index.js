const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 化妆注意事项图片在云存储中的 fileID（云开发控制台 → 云存储 → notice/notice.jpg）。
// 存储桶保持「仅创建者可读写」即可：这里是 admin SDK，getTempFileURL 会绕过 ACL，
// 换成带签名的 https 临时链接下发，顾客拿到后 <image show-menu-by-longpress> 才能保存到相册。
// 直接把 cloud:// fileID 丢给顾客的 <image> 会因 ACL 校验而一片空白（同素颜照那个坑）。
// 注意：本地包内的图片长按不会弹出保存菜单，所以必须走临时链接这条路。
const NOTICE_FILE_ID = 'cloud://cloud1-d1g82tuwue6aeadb2.636c-cloud1-d1g82tuwue6aeadb2-1502005871/notice.jpg';

exports.main = async () => {
  if (!NOTICE_FILE_ID || NOTICE_FILE_ID.indexOf('cloud://') !== 0) {
    return { success: false, message: '注意事项图片未配置' };
  }

  try {
    const res = await cloud.getTempFileURL({ fileList: [NOTICE_FILE_ID] });
    const f = (res.fileList || [])[0];
    if (!f || f.status !== 0 || !f.tempFileURL) {
      console.error('getTempFileURL failed:', res);
      return { success: false, message: '注意事项图片获取失败' };
    }
    return { success: true, url: f.tempFileURL };
  } catch (err) {
    console.error('getNoticeImage error:', err);
    return { success: false, message: '注意事项图片获取失败' };
  }
};
