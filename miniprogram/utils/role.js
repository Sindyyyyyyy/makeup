// utils/role.js - 化妆师 / 顾客双端身份与视图模式
//
// 服务端真正的身份是 users 文档上的 admin 标记（adminLogin 置 true、adminLogout
// 置 false）。本地这份 admin_token 只是它的一份可重签缓存：令牌过期或丢失后，
// refreshAdminToken() 会拿 openid 去问服务端"我是不是化妆师"，是就补发一张新令牌。
// 所以「我是不是化妆师」的答案在服务端，本地只决定"现在显示哪一端"。
// 注意这跟各 admin* 云函数的 verifyAdmin 是两回事：鉴权仍然只看令牌签名和有效期。
//
// 视图模式（admin_mode）与登录态分开存：切到顾客端只是换个视图，令牌仍然有效，
// 化妆师来回切不用重新输管理密码。

const { t } = require('./i18n.js');

const TOKEN_KEY = 'admin_token';
const MODE_KEY = 'admin_mode'; // 'admin' | 'customer'

// 首页 tab 在两种模式下长得不一样：图标和文案都要换。
// 图标是画出来的图片，跟语言无关；文案只有顾客端这一侧跟随语言
// （化妆师后台是化妆师自己用的工具，本次不做翻译，保持中文）。
const TAB_STYLE = {
  customer: {
    // 路径写法与 app.json 的 tabBar 保持一致（相对小程序根目录）
    iconPath: 'images/tabbar/home.png',
    selectedIconPath: 'images/tabbar/home-active.png',
  },
  admin: {
    iconPath: 'images/tabbar/manage.png',
    selectedIconPath: 'images/tabbar/manage-active.png',
  },
};

// tab 页白名单。wx.setTabBarItem 只能在 tab 页调用（否则报 not TabBar page），
// 所以凡是会改 tab 文案的函数都先过这道断言，免得以后被挪到非 tab 页时炸掉。
const TAB_PAGES = ['pages/index/index', 'pages/profile/profile'];

function isTabPage() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : null;
  if (!pages || !pages.length) return false;
  const cur = pages[pages.length - 1];
  return !!cur && TAB_PAGES.indexOf(cur.route) >= 0;
}

// 首页 tab 的文案。顾客端跟随语言，化妆师后台固定中文。
function tabText(mode) {
  return mode === 'admin' ? '化妆师后台' : t('tab.index');
}

// 首页 tab 的导航栏标题。同样：顾客端跟随语言，后台固定中文。
function navTitle(mode) {
  return mode === 'admin' ? '化妆师后台' : t('nav.index');
}

// 是不是已登录的化妆师。只看本地有没有令牌——不解析 exp 判断有效期：
// 服务端返回 UNAUTHORIZED 才是权威答案，客户端解码等于复制一份密码学逻辑
// 却没有任何好处（而且载荷是 base64 的 {exp}，本地也没有密钥可校验签名）。
function isLoggedIn() {
  return !!wx.getStorageSync(TOKEN_KEY);
}

// 当前该显示哪一端。只看 admin_mode，不看令牌——「化妆师入口」按下去后即使还没
// 输密码、也还没有令牌，首页也必须稳定停在登录框上（否则切一下 tab 登录框就
// 消失了，用户没法输密码）。令牌只用来区分后台里的「登录框」和「真后台」。
//   clearAdmin() 会把模式一起清掉，所以退出登录/令牌过期必然落回顾客端
function currentMode() {
  return wx.getStorageSync(MODE_KEY) === 'admin' ? 'admin' : 'customer';
}

function setMode(mode) {
  wx.setStorageSync(MODE_KEY, mode === 'customer' ? 'customer' : 'admin');
}

// 退出登录：令牌和模式一起清，退回普通顾客。
// 只清本地。服务端 users.admin 由 adminLogout 单独撤销——两者必须都做，
// 少了任何一边都会出现"以为退出了其实没退"或"退出后还得输密码"的问题。
function clearAdmin() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(MODE_KEY);
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function saveToken(token) {
  if (token) wx.setStorageSync(TOKEN_KEY, token);
}

// 登录成功：存令牌 + 切到后台视图
function setAdminSession(token) {
  saveToken(token);
  setMode('admin');
}

// 免密重签：问服务端"我还是不是化妆师"，是就补发一张令牌。
// 全项目只有这一处调 adminLogin 的 refresh 分支，登录页和后台面板都复用它。
//
//   ok:true  → 已存好新令牌
//   ok:false → 各种 code 归一为"需要密码"（NOT_ADMIN / NO_OPENID / NO_COLLECTION / 网络错误）
async function refreshAdminToken() {
  try {
    const res = await wx.cloud.callFunction({
      name: 'adminLogin',
      data: { action: 'refresh' },
    });
    const r = res.result;
    if (r && r.success && r.token) {
      saveToken(r.token);
      return { ok: true };
    }
    return { ok: false, code: (r && r.code) || 'FAILED' };
  } catch (e) {
    console.warn('免密重签失败', e);
    return { ok: false, code: 'NETWORK' };
  }
}

// 两个 tab 的文案与图标。**不改导航栏标题** ——
// wx.setNavigationBarTitle 只作用于当前显示的页面，在个人中心调 syncTabBar
// 会把个人中心的标题刷成首页的「我的化妆预约」。语言切换要用的是这个。
function syncTabBarItems(mode) {
  if (!isTabPage()) return;
  const m = mode === 'admin' ? 'admin' : 'customer';
  const style = TAB_STYLE[m];
  wx.setTabBarItem({
    index: 0,
    text: tabText(m),
    iconPath: style.iconPath,
    selectedIconPath: style.selectedIconPath,
  });
  wx.setTabBarItem({ index: 1, text: t('tab.profile') });
}

// 首页 tab 的文案/图标/导航栏标题跟随模式切换。只能在 tab 页调用。
function syncTabBar(mode) {
  syncTabBarItems(mode);
  wx.setNavigationBarTitle({ title: navTitle(mode) });
}

module.exports = {
  TOKEN_KEY,
  MODE_KEY,
  isLoggedIn,
  currentMode,
  setMode,
  clearAdmin,
  getToken,
  saveToken,
  setAdminSession,
  refreshAdminToken,
  syncTabBar,
  syncTabBarItems,
};
