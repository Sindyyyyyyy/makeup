// components/adminPanel - 化妆师后台面板
//
// 由 pages/index 按视图模式渲染（化妆师模式下挂载，顾客端模式下卸载），这样
// 首页 tab 始终是同一个页面，底部「首页 / 个人中心」导航不会消失。
//
// 页面级的 onLoad/onShow/onPullDownRefresh 组件都没有，宿主 pages/index 负责
// 调本组件的 loadBookings()/refresh()。
const { SLOT_NAME_MAP, STATUS_TEXT } = require('../../utils/slots.js');
const { isLoggedIn, getToken, clearAdmin, refreshAdminToken } = require('../../utils/role.js');
const { TPL_ARTIST_NEW, TPL_ARTIST_CANCELLED, requestSubscribe } = require('../../utils/notify.js');

function formatDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

// 统计卡片按状态计数，和筛选用的是同一份口径，抽出来给加载与本地打补丁共用
function countByStatus(bookings) {
  const stats = { pending: 0, confirmed: 0, completed: 0, rejected: 0, cancelled: 0 };
  bookings.forEach(b => {
    if (Object.prototype.hasOwnProperty.call(stats, b.status)) stats[b.status]++;
  });
  return stats;
}

Component({
  properties: {
    // 宿主传进来的当前模式（'admin'）。仅作语义标识，加载逻辑不依赖它——
    // 组件在宿主里是 wx:if/wx:else 互斥渲染的，每次切进后台都会重新挂载。
    active: { type: String, value: 'admin' },
  },

  data: {
    // 这里的 isAdmin 语义是「有没有管理令牌」，不是「当前是不是显示后台」——
    // 组件本来就只在后台模式下才挂载。
    isAdmin: false,
    bookings: [],
    filtered: [],
    stats: { pending: 0, confirmed: 0, completed: 0, rejected: 0, cancelled: 0 },
    filterStatus: 'all',
    statusText: STATUS_TEXT,
    page: 0,
    hasMore: false,
    // 顾客个人信息（只读查看）
    showUserProfile: false,
    userInfo: null,
    userNickname: '',
    userInfoHint: '',
    // 「想画的妆容照片」的 https 临时链接（存在这一单上，不在顾客资料上）
    userStyleRefUrls: [],
    // 订阅消息（一次性）的 UI 提示。**不是服务端状态**——服务端不查它，
    // 能不能发出去取决于微信侧的额度，这里只是「她点过没有」的展示。
    notifyEnabled: false,
  },

  // 只校验本地是否存在令牌，真正的鉴权在云函数。
  // 没有令牌不一定是"不是化妆师"——可能是令牌过期或被清掉了，交给 ensureSession
  // 去问一次服务端，它能用免密重签补回来。
  ready() {
    this.setData({ isAdmin: isLoggedIn() });
    this.setData({ notifyEnabled: !!wx.getStorageSync('notify_artist') });
    // _minting 是实例字段不是 data：ready() 里已经在 setData，再放 data 会和首次渲染竞争
    this.ensureSession().then((ok) => {
      if (ok) this.loadBookings();
    });
  },

  // Component 的方法必须挂在 methods 下——写在顶层会被静默忽略，
  // ready() 里 this.ensureSession 就会是 not a function。
  methods: {
    // 令牌缺失时先静默重签一次（只有后台视图才会走到这里，普通顾客不会多打任何调用）。
    // 重签也失败 → 说明是已退出或从未登录的化妆师，留在后台视图显示「去登录」，
    // 不擅自切回顾客端：否则她点了化妆师入口又被弹回顾客页，根本没地方输密码。
    async ensureSession() {
      if (getToken()) {
        this.setData({ isAdmin: true });
        return true;
      }
      const r = await refreshAdminToken();
      this.setData({ isAdmin: r.ok });
      return r.ok;
    },

    // 宿主下拉刷新时调用。必须返回整条链，否则 pages/index.onPullDownRefresh
    // 会立刻 stopPullDownRefresh，列表空白直到静默重签落地。
    // 课程表一并刷新：她下拉多半是为了看新时段或新预约，两者都要看到同一时刻的状态。
    //
    // 令牌确认之后，预约列表与课程表互不依赖（不同云函数、不同集合），
    // 串行只是白等一个完整往返——并发发出后下拉刷新的等待时间直接砍半。
    refresh() {
      return this.ensureSession().then((ok) => {
        if (!ok) return undefined;
        return Promise.all([this.loadBookings(), this.reloadScheduleGrid()]).then(() => {});
      });
    },

    // 课程表组件可能还没渲染出来（首帧 isAdmin 还是 false），取不到就跳过。
    // reload() 只重拉时段表；妆造库在组件 attached 时就走过 styleCache，这里
    // 再拉一遍是重复的。
    reloadScheduleGrid() {
      const c = this.selectComponent('#scheduleGrid');
      return c ? c.reload() : Promise.resolve();
    },

    // 登录表单在独立页 pages/adminLogin，这里只负责把人送过去
    goLogin() {
      wx.navigateTo({ url: '/pages/adminLogin/adminLogin' });
    },

    // 退出 = 撤销服务端身份 + 清本地状态，两件事都要做。
    // 顺序有讲究：先撤销服务端，再无条件清本地。
    //   · 只清本地不撤销 → users.admin 还留着 true，下次点化妆师入口又被静默送回后台，
    //     退出就成了假动作
    //   · 撤销失败就不清 → 网络一断她被困在后台视图里出不来
    // 所以无论成败都清本地，但失败时要如实告诉她"没退干净"。
    async logout() {
      const r = await new Promise((resolve) => {
        wx.showModal({
          title: '退出化妆师后台？',
          content: '退出后下次进入需要重新输入管理密码',
          confirmColor: '#C95B7C',
          success: resolve,
          fail: () => resolve({ confirm: false }),
        });
      });
      if (!r || !r.confirm) return;

      let revoked = false;
      try {
        const res = await wx.cloud.callFunction({ name: 'adminLogout', data: {} });
        revoked = !!(res.result && res.result.success);
      } catch (e) {
        console.error('撤销化妆师身份失败', e);
      }

      clearAdmin();
      this.setData({
        isAdmin: false,
        bookings: [],
        filtered: [],
        page: 0,
        hasMore: false,
        stats: { pending: 0, confirmed: 0, completed: 0, rejected: 0, cancelled: 0 },
      });
      this.triggerEvent('modechange', { mode: 'customer' });

      if (revoked) {
        wx.showToast({ title: '已退出', icon: 'success' });
      } else {
        // 绝不能让她以为撤销成功了其实没有
        wx.showModal({
          title: '已退出本机',
          content: '服务器端身份未清除，稍后请再试一次退出',
          showCancel: false,
        });
      }
    },

    // 令牌过期/无效：先试一次免密重签，还不行才真的落到顾客端。
    // 返回 true 表示重签成功、调用方可以重试原请求。
    async handleAuthFail() {
      // 已经有另一个请求在重签了（比如列表和详情同时 401），别重复、也别清身份，
      // 静默让路，等那次重签的结果落地
      if (this._minting) return false;

      const r = await this.tryRemint();
      if (r.ok) return true;

      // 网络异常不是身份问题，别清身份，把她留在原地重试就好。
      // 必须和「服务端说不认」区分开，否则一断网就把人踢出后台
      if (r.code === 'NETWORK') {
        wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' });
        return false;
      }

      // 重签失败 = 服务端已不认这个身份（退出了或从未登录），真的清掉
      clearAdmin();
      this.setData({ isAdmin: false, bookings: [], filtered: [] });
      this.triggerEvent('modechange', { mode: 'customer' });
      wx.showToast({ title: '请重新输入管理密码', icon: 'none' });
      return false;
    },

    // 免密重签一次。_authChecked 是「已经确认不是化妆师」的粘滞标记：
    // 确认过后本组件生命周期内不再反复去问服务端（也防止刚签的令牌又被拒时死循环）。
    async tryRemint() {
      if (this._authChecked) return { ok: false, code: 'NOT_ADMIN' };
      this._minting = true;
      const r = await refreshAdminToken();
      this._minting = false;
      if (r.ok) {
        this.setData({ isAdmin: true });
        return r;
      }
      // 网络失败要能和"服务端说不认"区分开
      if (r.code !== 'NETWORK') this._authChecked = true;
      return r;
    },

    async loadBookings(append = false) {
      let token = getToken();
      if (!token) {
        // 令牌没了（过期被清、或进场之后又被删）→ 先补一张再拉，别直接摆空列表
        if (!(await this.tryRemint()).ok) return;
        token = getToken();
        if (!token) return;
      }
      try {
        const page = append ? this.data.page + 1 : 0;
        const res = await wx.cloud.callFunction({
          name: 'adminGetBookings',
          data: { token, page, pageSize: 50 },
        });
        if (res.result && res.result.success) {
          const mapped = res.result.bookings.map(b => ({
            ...b,
            // 预约自带的时间段快照才是权威值（化妆师改过时间它会跟着更新），
            // SLOT_NAME_MAP 只是它缺失时的兜底。
            slotLabel: b.slotName || SLOT_NAME_MAP[b.slot] || b.slot,
            createdAtText: formatDateTime(b.createTime),
          }));
          const bookings = append ? this.data.bookings.concat(mapped) : mapped;

          this.setData({
            isAdmin: true,
            bookings,
            stats: countByStatus(bookings),
            page,
            hasMore: !!res.result.hasMore,
          });
          this.applyFilter();
        } else if (res.result && res.result.code === 'UNAUTHORIZED') {
          // 令牌过期：静默重签一次再重试，别把她弹去输密码。
          // handleAuthFail 内部有 _authChecked 粘滞守卫，重签失败后递归到此会立即返回
          if (await this.handleAuthFail()) return this.loadBookings(append);
          return;
        } else {
          wx.showToast({ title: (res.result && res.result.message) || '加载失败', icon: 'none' });
        }
      } catch (e) {
        console.error(e);
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    },

    loadMore() {
      if (!this.data.hasMore) return;
      this.loadBookings(true);
    },

    onFilter(e) {
      this.setData({ filterStatus: e.currentTarget.dataset.status }, () => {
        this.applyFilter();
      });
    },

    applyFilter() {
      const { bookings, filterStatus } = this.data;
      const filtered = filterStatus === 'all'
        ? bookings
        : bookings.filter(b => b.status === filterStatus);
      this.setData({ filtered });
    },

    // 状态翻转后就地改那一条记录 + 重算统计 + 走一遍筛选。
    // 处于筛选视图时那条会从当前列表里消失，这是对的——它已经不属于这个筛选条件了。
    patchBookingStatus(id, status) {
      const bookings = this.data.bookings.map(b => (b._id === id ? { ...b, status } : b));
      this.setData({ bookings, stats: countByStatus(bookings) }, () => {
        this.applyFilter();
      });
    },

    // 查看顾客的个人信息（只读）。资料以云端为准，每次点开都重新拉
    // 传预约 _id 而不是 openid：「想画的妆容照片」存在这一单上，
    // 服务端从预约文档里取 openid，比客户端传的可靠。
    async openUserProfile(e) {
      const bookingId = e.currentTarget.dataset.bookingId;
      if (!bookingId) return;
      let token = getToken();
      if (!token) {
        // 同 loadBookings：令牌没了先补一张，而不是直接摆一张失效卡片
        if (!(await this.tryRemint()).ok) return;
        token = getToken();
        if (!token) return;
      }
      wx.showLoading({ title: '加载中', mask: true });
      try {
        const res = await wx.cloud.callFunction({
          name: 'adminGetUserProfile',
          data: { token, bookingId },
        });
        const r = res.result;
        if (!r || !r.success) {
          if (r && r.code === 'UNAUTHORIZED') {
            await this.handleAuthFail();
          } else {
            wx.showToast({ title: (r && r.message) || '读取失败', icon: 'none' });
          }
          return;
        }
        const info = r.exists ? r.info : null;
        this.setData({
          showUserProfile: true,
          userInfo: info,
          userNickname: (r.profile && r.profile.nickname) || '',
          // 参考图的 https 临时链接（空数组 = 顾客这次没传）
          userStyleRefUrls: r.styleRefUrls || [],
          userInfoHint: r.exists
            ? '顾客自己填写，以这里显示的为准'
            : '该顾客还没有填写个人信息',
        });
      } catch (err) {
        console.error('读取顾客资料失败', err);
        wx.showToast({ title: '读取失败', icon: 'none' });
      } finally {
        wx.hideLoading();
      }
    },

    closeUserProfile() {
      // 参考图也一起清掉：不然下次打开别人的资料时会残留上一次的图
      this.setData({ showUserProfile: false, userStyleRefUrls: [] });
    },

    // 订阅消息：点一次 +1 条「新预约提醒」额度（两个模板在同一个弹窗里一次授权，
    // tmplIds 上限 3 个，不需要分两次打扰）。
    //
    // 为什么用显式按钮，而不是搭 doAction 的顺风车：
    //   ① doAction 第一件事就是 wx.showModal，它的 dismiss 动画还没结束就压上一个
    //      系统订阅弹窗，iOS 上有概率被吞掉手势直接 fail；
    //   ② 点「确认」却问「预约取消通知」语义对不上，用户会习惯性点拒绝，把额度拒掉；
    //   ③ 订阅失败容易被下面 doAction 的 toast 逻辑混进「操作失败」分支。
    async enableNotify() {
      const res = await requestSubscribe([TPL_ARTIST_NEW, TPL_ARTIST_CANCELLED]);
      const accepted = !!(res && res[TPL_ARTIST_NEW] === 'accept');
      if (!accepted) {
        // 拒绝不影响后台任何功能，如实说明但不要表现得像故障
        return wx.showToast({ title: '未开启通知，不影响后台使用', icon: 'none' });
      }
      wx.setStorageSync('notify_artist', true);
      this.setData({ notifyEnabled: true });
      wx.showToast({ title: '已开启', icon: 'success' });
    },

    async doAction(e) {
      const { id, action } = e.currentTarget.dataset;
      const actionLabel = { confirm: '确认', reject: '拒绝', complete: '标记完成' }[action] || '操作';

      const r = await new Promise(resolve => {
        wx.showModal({
          title: `${actionLabel}这条预约？`,
          content: action === 'complete' ? '标记为已完成服务' : '',
          confirmColor: '#C95B7C',
          success: resolve,
          fail: resolve,
        });
      });
      if (!r || !r.confirm) return;

      try {
        const res = await wx.cloud.callFunction({
          name: 'adminUpdateBooking',
          data: {
            bookingId: id,
            action,
            token: getToken(),
          },
        });
        if (res.result && res.result.success) {
          wx.showToast({ title: res.result.message || '操作成功', icon: 'success' });
          // 就地改这一条，不重拉整页：那一次 loadBookings 是一次云函数调用
          // 外加 50 条 booking 文档过桥，而要变的字段（status）本来就在本地。
          // 新状态由 adminUpdateBooking 回传（status 字段），比在客户端复刻
          // 状态机可靠——万一以后加了新动作，客户端不会算错。
          //
          // 课程表里那个时段的占用标记仍旧是旧的，原来也是这样：doAction 只重拉
          // 了预约列表。下拉刷新会同时刷两者（见 refresh()），数据不会长期漂移。
          if (res.result.status) {
            this.patchBookingStatus(id, res.result.status);
          } else {
            // 兜底：万一部署的还是旧版云函数（没有 status 字段），退回原来的行为
            this.loadBookings();
          }
        } else if (res.result && res.result.code === 'UNAUTHORIZED') {
          await this.handleAuthFail();
        } else {
          wx.showToast({ title: (res.result && res.result.message) || '操作失败', icon: 'none' });
        }
      } catch (e) {
        console.error(e);
        wx.showToast({ title: '操作失败', icon: 'none' });
      }
    },

    goSlots() {
      wx.navigateTo({ url: '/pages/adminSlots/adminSlots' });
    },

    goStyles() {
      wx.navigateTo({ url: '/pages/adminStyles/adminStyles' });
    },
  },
});
