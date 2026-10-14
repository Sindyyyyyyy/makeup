# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A WeChat Mini Program (微信小程序) for a makeup artist's appointment booking (化妆预约). Customers pick a date + one of three time slots and submit a booking from the home page (首页); the makeup artist (admin) opens/closes slots per date and manages booking status from the 化妆师后台, which occupies the *same* 首页 tab. All data lives in WeChat Cloud Development (云开发) — there is no server of its own and no build step.

## Architecture

Two halves that talk only through cloud functions:

- **Mini program** (`miniprogram/`) — plain WXML/WXSS/JS, no framework, no npm. Pages are registered in `miniprogram/app.json` (`pages/index`, `pages/profile`, `pages/adminLogin`, `pages/adminSlots`, `pages/adminStyles`) and nothing else may be added there without registering it. Shared UI lives in `miniprogram/components/` (`infoForm`, `adminPanel`, `scheduleGrid`); a page must declare them in its own `.json` `usingComponents`. A component directory's files must be named after the directory (`adminPanel/adminPanel.js`), **not** `index.js` — `usingComponents` paths are resolved literally. Static images live in `miniprogram/images/` (currently only the tabBar icons). WeChat's cloud quickstart leftovers (`pages/example`, `components/cloudTipModal`, `envList.js`, `images/`) were moved to `delete/` — see that folder's README; the tabBar icons in `images/tabbar/` were copied from there and recolored to the project palette with Pillow.

### 双端首页（顾客 ⇄ 化妆师）

`pages/index` is one page that renders **two mutually exclusive UIs**, picked by `data.adminMode`: the customer booking grid, or the artist dashboard (`components/adminPanel`). There is deliberately no separate admin *dashboard page* — it used to be a normal page reached via `wx.navigateTo`, which made the tab bar disappear; keeping it inside 首页 means the 首页/个人中心 bar is always there.

Login is a **separate non-tab page**, `pages/adminLogin` (`navigationStyle: custom`, so it has no bottom tab bar and only its own top-left back arrow). Tapping 化妆师入口 in 个人中心 goes there; it does **not** touch `admin_mode` — merely opening the page isn't logging in, and it would then have to be undone on cancel. Only a successful `adminLogin` sets `admin_mode: 'admin'` and `switchTab`s to 首页. Its back arrow `switchTab`s to 首页 and resets the mode to `customer` when there's no token.

### 免密登录（users.admin 标记）

The artist's identity is a boolean **`admin` field on her `users` doc**, not the password. `adminLogin` writes it `true`; the dashboard's 退出 button calls `adminLogout` to write it back `false`. One password entry, then passwordless forever until she explicitly logs out.

`adminLogin` takes an explicit `action`:

| `event.action` | auth required | behavior |
|---|---|---|
| `'login'` (default) | `password === ADMIN_PASSWORD` | sets `users.admin = true`, mints a token |
| `'refresh'` | `users[OPENID].admin === true` | mints a token with **no password** |

**Any missing or unrecognized `action` degrades to `'login'`, never to `'refresh'`** — a typo must not open the passwordless path. A wrong password returns immediately: it must never fall through to `refresh`. The `refresh` branch never reads `event.password`; the `login` branch never reads `users` to authorize.

> **Core invariant: `admin` can mint a token; a token can never mint `admin`.** Only the password sets it. This is what makes 退出 meaningful.

The local `admin_token` is just a **re-mintable cache** of that server identity. When it's gone or expired, `role.js`'s `refreshAdminToken()` asks the server "am I still the artist?" and gets a fresh one without a password. `adminPanel` calls it in `ready()` and again on `UNAUTHORIZED` (guarded by `_authChecked`, an instance field — never `data`, or a `setData` in `ready()` races the first render), so a cold start after 7 days silently re-mints instead of showing a password box.

`adminLogout` revokes **self only**: the target openid comes from `cloud.getWXContext()` and never from `event`, so no caller can revoke anyone else. It **deliberately does not check the token** — if it did, an expired token would make 退出 a no-op while `users.admin` stayed `true`. It's a strict self-downgrade, so skipping the check grants nothing; unauthenticated callers can at worst clear a flag that isn't theirs (a no-op).

**`admin` is server-owned.** It is written only by `adminLogin`/`adminLogout` and is deliberately absent from `userProfile`'s whitelist patches and from its `get` response. Adding it to the `get` response would tempt an `if (r.admin)` gate that authorizes nothing. `adminLogin` writes it with `update()`, falling back to `set()` **only** when the doc doesn't exist (`-502003`) — `set()` replaces the whole doc and would wipe `info`/nickname/avatar, which matters because 化妆师 may never have opened 个人中心.

`miniprogram/utils/role.js` is the single source of truth for "which side am I on" and must be used instead of touching storage directly:

- `isLoggedIn()` — is there an `admin_token` locally. Token-string presence only; **don't** decode `exp` client-side (no key to verify the signature, and the server's `UNAUTHORIZED` is authoritative).
- `currentMode()` — reads `admin_mode` only; it is a *view* preference, never an authorization signal.
- `setMode()`, `clearAdmin()` (drops both keys → lands on the customer side), `getToken()`, `saveToken()`, `setAdminSession()`, `refreshAdminToken()` — the **only** caller of `adminLogin{action:'refresh'}` in the app.
- `syncTabBar(mode)` — rewrites index 0's text/icons/nav title via `wx.setTabBarItem` (`home*.png` ⇄ `manage*.png`); tab pages only.

Since `currentMode()` ignores the token, a stale `admin_mode: 'admin'` with no token leaves 首页 showing the dashboard's 去登录 card. Recovery: tap 去登录, or 顾客端入口 in 个人中心 (which shows whenever `currentMode() === 'admin'`, token or not — otherwise there'd be no way out). `adminPanel.ensureSession()` intentionally does **not** switch back to the customer side on failure, for the same reason.

切换 between the two ends is a *view* switch, not a logout: 化妆师 bounces between 顾客端入口 and 化妆师入口 without re-entering the password.

`components/adminPanel` has no page lifecycle — `pages/index` drives it (`ready()` loads once; `index.onPullDownRefresh` calls `refresh()`, which must **return the whole promise chain** or the pull-down spinner stops before data lands). Methods must live under `methods` (top-level methods are silently dropped by `Component`, unlike `Page`). `logout()` revokes server-side first, then clears local state **regardless of outcome** — skipping the revoke leaves `users.admin` true (退出 becomes fake), while gating the clear on success traps her in the dashboard on a network blip. It differentiates the toast so a failed revoke is never reported as success.

### Tab bar

`app.json` defines a native two-item tabBar: `pages/index/index` (首页) and `pages/profile/profile` (个人中心). Tab pages are cached, so their `onLoad` runs only once — anything that must refresh on every visit belongs in `onShow` (`index` already reloads there, and re-reads `currentMode()` there because the artist may have switched sides from 个人中心). Navigate **between** tab pages with `wx.switchTab` only; `wx.navigateTo` fails on a tab page. `adminSlots`/`adminStyles` are not tabs and are reached from the dashboard via `wx.navigateTo`.
- **Cloud functions** (`cloudfunctions/<name>/index.js`) — one directory per function, each with its own `package.json` depending on `wx-server-sdk ~2.6.3`. Every function starts with `cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })`; the env ID is hardcoded once in `miniprogram/app.js` (`globalData.env`).

There is no custom component other than `components/infoForm`, `components/adminPanel` and `components/scheduleGrid`.

### 课程表组件 (components/scheduleGrid)

时段的周导航 + 3×7 网格 + 点格子弹出的妆造编辑弹窗 + 弹窗里的只读顾客信息弹窗，全部收在这一个组件里，**`pages/adminSlots` 和 `components/adminPanel` 引用的是同一份**。后台首页把它放在「开启提醒」行和统计卡之间，开关时段/设妆造不必再跳页；首页的「时段管理」入口按钮保留（妆容管理仍需跳转）。`adminSlots` 因此瘦成只剩标题栏/未登录提示/返回的壳，课程表样式也从 `adminSlots.wxss` 挪进了组件。

约定（与 `infoForm` 同一套）：

- 组件方法**必须**挂在 `methods` 下，`attached()` 里做首拉（`adminListSlots` + `adminStyles`）。自定义组件样式默认 `styleIsolation: isolated`，所以宿主 adminPanel 的 `.btn-primary` / `.container` 与组件内的同名类互不干扰，两个 `.wxss` 里出现同名类是安全的。
- 宿主用 `selectComponent('#scheduleGrid').reload()` 驱动重拉；`reload` 返回 Promise，**只重拉时段表**（妆造库由 `styleCache` 在 `attached()` 时拉一次，见「调用次数」一节）。**取不到组件要容错**——首帧 `isAdmin` 还是 false 时子组件尚未渲染；`adminSlots.onShow` 的首次调用正是这种情况，真正的首拉由 `attached()` 负责，不会重复发请求。
- 开关时段 / 保存妆造后**不要 `loadSlots()`**：云函数回传 `slotState`，用 `patchCell()` 就地改那一个格子。见「调用次数」一节。
- 令牌失效时组件**只 toast 并 `triggerEvent('authfail')`，绝不清本地登录状态**：后台首页的 `handleAuthFail()` 要先静默重签，组件自己 `removeStorageSync` 会把那扇门掐断。页面的 `handleAuthFail` 才调 `clearAdmin()`。
- `info-form` 由组件自己的 `.json` 注册（弹窗需要），`adminSlots.json` 里不再有它。

### Cloud database collections

- `timeSlots` — one doc per `date` (`YYYY-MM-DD`) with fields `morning`/`afternoon`/`evening`, each `{ open, booked, done, styles? }` where `styles` is a list of `{ name, price }` (the 妆造 options offered for that slot). Created lazily by `adminSetTimeSlot` (all other slots default closed).
- `bookings` — one doc per appointment: `_openid`, `date`, `slot`, `slotName`, `name`, `skinType`, `remark`, `styleName`, `stylePrice`, `status`, `createTime`, `updateTime`.
- `users` — one doc per customer, keyed by `doc(openid)`: `_openid`, `avatarUrl`, `nickname`, `info`, `updateTime`, and the server-owned `admin` / `adminUpdateTime` (see 免密登录 below). `info` is the 个人信息表 written by `pages/profile`: `gender`, `skinType`, `sensitiveLevel`, `hasAcne`, `hasCosmeticSurgery`, `hasAllergy`, `allergyNote`, `photos` (array of cloud-storage fileIDs, ≤ 5). Two fields are conditional and the server enforces it, not just the UI: `sensitiveLevel` is kept only while `skinType === '敏感性'`, and `allergyNote` only while `hasAllergy === '有'` — a stale free-text value is dropped whenever its parent toggle turns off. **`admin` must never enter any whitelist patch or the `get` response — it is written only by `adminLogin`/`adminLogout`.** **This collection must be created manually in the cloud console** (permission: 仅创建者可读写) — the function turns the resulting `-502005` into a readable message but cannot create it itself. Without it, passwordless re-mint always fails and the artist re-enters the password every time.

### Customer profile (头像/昵称/个人信息表)

`pages/profile` renders the WeChat avatar and nickname: `<button open-type="chooseAvatar">` and `<input type="nickname">` (both need 基础库 ≥ 2.21.2). The avatar temp path from `chooseAvatar` is uploaded to cloud storage immediately (`avatars/<timestamp>-<rand>.<ext>`) and only the resulting `fileID` is kept — the temp path is not durable. Bare-face photos go to `bareface/<timestamp>-<i>-<rand>.<ext>`, max 5, via `wx.chooseMedia`.

The `users` doc is the source of truth; `wx.setStorageSync('user_profile' / 'user_info', …)` are render caches only, to make the page open instantly.

**素颜照 fileID 只能上传者本人直接渲染，化妆师看不到。** `<image src="cloud://…">` 会按当前用户的 openid 校验存储桶的 ACL，桶若是「仅创建者可读写」，顾客能看自己的照片，化妆师后台却一片空白——代码和数据都没错，症状却像丢图。别去放宽桶权限（素颜照敏感，任何用户拿到 fileID 就能读别人的）。正确做法是 `adminGetUserProfile` 用 admin SDK 调 `cloud.getTempFileURL` 换成 https 临时链接再返回；admin SDK 绕过 ACL，桶权限保持不变。顾客端存回 `users` 的仍是 fileID，别把临时链接写进库（会过期）。这是存储 API 调用，不消耗云函数调用次数，但只在化妆师点开「详细信息」时触发，照片为空要直接短路。

Two `userProfile` actions write the doc, and they must stay separate: `save` (avatar + nickname) and `saveInfo` (the form). The form does **not** edit 昵称 — it shows the header's nickname as read-only text, because the two fields are the same `nickname` in the doc and letting both edit it invites drift. `openInfo` seeds `form.nickname` from the header so the display is never stale. All enum values are whitelisted server-side, and `photos` entries that are not `cloud://`/`http(s)://` URLs are dropped.

**`doc().set()` replaces the whole document — never use it to update a single field here.** The header save originally did, which silently wiped the form. Both actions now read first (`readDoc`) and use `update({ data })` when the doc exists, falling back to `set` to create it. Also note: cloud-function-side `set`/`update`/`add` all require the `{ data: {...} }` wrapper; passing bare fields fails with `parameter.data should be object instead of undefined`.

**昵称 is entered in exactly one place and read everywhere else.** It is set on `pages/profile` and nowhere else — `pages/profile`'s info modal and the booking modal on `pages/index` both render it as read-only text (`form-static`, dashed border) and read it via `userProfile` `{action:'get'}`, with `wx.getStorageSync('user_profile')` as the fast first paint. `pages/index` still *sends* it as `createBooking`'s `name` field so the admin booking list is unchanged; do not rename that field. An empty nickname blocks booking with 请先到个人中心设置昵称.

### 个人信息表组件 (components/infoForm)

`components/infoForm/` is the single copy of the form — used by `pages/profile` (title 个人信息, `require-complete=false`, so it saves partially-filled data), `pages/index` as the pre-booking confirmation and its 详细信息 button, and `pages/admin` with `readonly` for viewing a customer's data. All three register it in their page `.json` via `usingComponents`. The component owns editing and photo upload only; the parent decides where to store and what happens after. Custom components exist only here — don't add more casually.

`readonly` (admin only) makes chips/inputs/photo upload inert and swaps the footer for a single 关闭 button; the guards live in the JS handlers as well as the template. Data comes from the new `adminGetUserProfile` cloud function, which verifies the admin token (duplicated `verifyAdmin` block, per convention), validates the openid shape, and returns a **whitelisted** set of fields — never spread the raw `users` doc back. A missing record is `success:true, exists:false`, not an error, so the page shows "该顾客还没有填写个人信息".

`adminGetUserProfile` has **two entry modes**: `openid` (dashboard booking cards) and `date`+`slot` (课程表里的「详细信息」按钮). The second exists purely to save 云函数调用次数 — 时段管理 only knows `booked: true`, and the customer's `_openid` lives solely in `bookings`, so a two-call client flow (adminGetBookings → adminGetUserProfile) becomes one call that resolves the booking server-side. It queries `.where({date})` only and filters `slot` in memory on purpose: a `date`+`slot` composite query may demand a new index. Nothing in the page prefetches bookings on modal open — opening the slot modal costs **zero** cloud calls, and the profile is fetched only when she taps 详细信息.

**Booking is gated on a complete profile, and the rule lives in two places that must agree:** `miniprogram/utils/profileInfo.js` (`missingFields(info, {requirePhoto})`) for the client, and `missingProfileFields(nickname, info)` in `cloudfunctions/createBooking/index.js` for the server. Required: 昵称, 性别, 肤质, 大面积爆痘, 整容/医美, 化妆品/发品过敏, plus conditional 敏感性程度 (only when 肤质=敏感性) and 过敏说明 (only when 过敏=有). For booking, 素颜照 needs ≥ 1; on 个人中心 photos stay optional. Both sides take `nickname` + `info` as separate args — never pass the whole user doc to the field-level helpers, that mistake reads as "everything missing".

Client-only enforcement would be worthless here, so `createBooking` re-checks server-side and returns `{code:'PROFILE_INCOMPLETE', missing}`; the page responds by reloading the profile and reopening the form so the gaps are visible.

`pages/index` renders the component in two modes via `data.infoMode`: `confirm` (before submitting a booking — complete + photo required, submitText 确认并预约, and saving continues into `createBooking`) and `view` (the 详细信息 button on each booking card — always open, never blocked on completeness, saves only). `openInfoDetail` is what switches to `view`; `submitBooking` switches to `confirm`. One component instance, mode chosen by the bound props.

### Booking slot lifecycle

Three fixed slots per day are defined **twice** and must be kept in sync manually: `miniprogram/utils/slots.js` (`SLOT_DEFS` — the frontend source of truth) and the `SLOT_KEYS`/`SLOT_NAMES` constants at the top of each cloud function. Slot names are `'8-11点'`, `'14-17点'`, `'18-21点'`.

Status state machine (enforced in `adminUpdateBooking` via `ACTION_MAP`):
`pending → confirmed → completed`, plus `pending → rejected`. Customers cancel via `cancelBooking`.

Known bug: the customer form sends only `name` and `styleName`, but `createBooking` runs `String(skinType).trim()`, which turns the missing `skinType` into the literal string `"undefined"` and persists it. `skinType` is currently not displayed anywhere, so it is latent. Fix with `String(skinType || '').trim()` if you touch that function.

Concurrency: `createBooking` claims a slot with a conditional single-document update (`{slot.open: true, slot.booked: false}` → `booked: true`, `done: false`) rather than read-then-write, and rolls the claim back if the `bookings` insert then fails. Preserve this if you refactor that path.

### 妆造 (makeup styles) pricing

Per-slot 妆造 options and prices are configured by the admin (后台首页课程表 或 `adminSlots` 课程表，同一份组件) and stored on the `timeSlots` doc, not on the booking. `createBooking` re-validates the chosen `styleName` against the slot's server-side list and **copies the price from the server** — the client never sends a price. If the slot has any styles configured, the customer must pick one.

### 调用次数：缓存与本地打补丁

免费额度每月 20 万次，不是随便花的。原则：**能本地改就别重拉，能并行就别串行；只有低风险数据才进缓存。**

**不缓存实时状态。** `bookings` / `timeSlots` 一律每次现拉 —— 刚放开的时段、刚确认的预约必须立刻看到，缓存会让化妆师对着过期的界面做决定。已有的节流口子在 `pages/index`（`LOAD_TTL` 60s，仅覆盖切 tab 往返）。

**只缓存两样东西**，都在 `storage` 里，TTL 到期或写操作发生时自动失效：

- **妆造库** → `miniprogram/utils/styleCache.js`（TTL 5 分钟）。`scheduleGrid` 和 `pages/adminStyles` 共用一份，不再各拉一次。妆容管理页每次增删都经 `applyLocalStyles` → `saveStyles` 把新列表写回缓存（连时间戳一起刷新），所以「刚改完就返回时段管理」拿到的必然是最新的一份 —— 这就是 `scheduleGrid.reload()` 不需要 `withStyles` 参数的原因。手动下拉刷新传 `{maxAgeMs: 0}` 绕过缓存。缓存**只存妆造列表，不存令牌**，也不绕过服务端的 `UNAUTHORIZED`。
- **注意事项图的 https 临时链接** → `pages/index` 里的 `NOTICE_CACHE_KEY`（TTL 90 分钟，链接本身约 2 小时过期）。

**改完就地打补丁，不要重拉整表。** 三个云函数会把刚写进去的那一条回传，客户端据此更新本地对象：

| 操作 | 云函数回传 | 客户端 |
|---|---|---|
| 确认/拒绝/标记完成 | `adminUpdateBooking` → `status` | `adminPanel.patchBookingStatus()` |
| 开关时段 / 保存妆造 | `adminSetTimeSlot` → `date`/`slot`/`slotState` | `scheduleGrid.patchCell()` |
| 妆造增删改 | `adminStyles` → `style`（含 `_id`） | `adminStyles.applyLocalStyles()` |

云函数**不返回 `sort`**：`add` 用「当前条数」当 sort、`update` 压根不碰它，两种都得由客户端从本地列表推算（新增排末尾、修改保持原位）。所有客户端改动都写了兜底：响应里没有对应字段（部署的还是旧版云函数）就退回原来的全量拉取，行为和以前完全一样。

`adminSetTimeSlot` 的 `slotState` 同时充当**新版本检测** —— 旧版函数会静默丢掉 `styles` 且不回传该字段，`saveStyles` 见到它缺失就弹窗提示重新部署。

**别把 `booking` 从 `pages/index` 的 `myBookings` 里裁掉** —— 首页「我的预约」历史列表真的要渲染它，`listWeekSchedule` 一次返回已经合并了两次调用。

**资料节流时间戳放在 storage 而不是页面实例字段**（`utils/profileInfo.js` 的 `fetchedAt/markFetched/clearFetched`）：首页和个人中心是两个 tab，实例字段互相看不见，共用一个才能真正只拉一次。任何写入资料的地方都要 `clearFetched()`。

**`pages/index` 的 `onSaveInfo` 会跳过空写**：confirm（预约）路径下，若表单与 `user_info` 缓存逐字段相同（`sameForm`），就不发 `userProfile saveInfo` 直接下单。老顾客复购时这是纯浪费的一次写入。**view（「详细信息」）路径必须照常写库**，否则她改了资料看不到效果。本地缓存万一已经过期，`createBooking` 会返回 `PROFILE_INCOMPLETE` 并回显缺项，不会漏。

**`refresh()` 里令牌确认之后的两个请求要并发** —— 预约列表和课程表互不依赖，串行只是白等一个完整往返（`Promise.all`）。但 `ensureSession` 必须在前面，因为它决定后面还发不发。

### 订阅消息 (subscribe message)

一次性订阅，三条链路：化妆师确认/拒绝 → 顾客，新预约 → 化妆师，顾客取消 → 化妆师。标记完成不通知。**长期订阅不可用**（仅公共服务类目开放），所以授权必须散落在真实手势上。

| 收件人 | 触发 | 模板 |
|---|---|---|
| 顾客 | `adminUpdateBooking` 的 `confirmed`/`rejected` | 化妆师通过／拒绝（`date2` 预约时间 / `thing3` 预约项目 / `phrase5` 预约结果 / `thing6` 温馨提示） |
| 化妆师 | `createBooking` 成功 | 顾客预约（`thing20` 预约人 / `time2` 预约时间 / `thing7` 预约项目 / `thing9` 温馨提示） |
| 化妆师 | `cancelBooking` 成功 | 顾客取消预约（`name1` 姓名 / `time4` 原预约时间 / `thing2` 原预约项目 / `thing13` 温馨提醒） |

**三个模板都没有单独的「时段」字段，时段是搭在预约时间里的** —— `date`/`time` 两种类型都接受 `2026-10-20 09:30:00` 这种带时分的格式（平台示例即如此），所以「预约时间」一个字段就同时表达了日期和具体时段，不必再加字段。

注意时段文档里存的是**区间**（`slotName` = `'09:30-11:30'`），整段塞进时间字段会被判非法，所以三个云函数都只取**开始**时间，拼成 `YYYY-MM-DD HH:mm:00`。开始时间的来源各不一样：`adminUpdateBooking` 从预约文档自带的 `booking.slotName` 切（用文档里的值而非另抄常量，时段定义改了自动跟着变），`createBooking`/`cancelBooking` 从 `SLOT_NAMES` 切。缺时段时退化成纯日期，消息仍能发出去。

**授权点**（`wx.requestSubscribeMessage` 必须由用户手势触发，放进 load/onShow/网络回调会报 `can only be invoked by user TAP action`）：

- 顾客：`pages/index` 的 `onSaveInfo()` **第一行**，门控 `infoMode === 'confirm'`。不在 `doCreateBooking` 里请求 —— 那里已跨过一次 `await userProfile` 的异步边界，会丢手势上下文。也不在 `submitBooking` 里 —— 那里紧接着弹信息表，顾客可能放弃预约，授权就浪费了。
- 化妆师：`adminPanel` 里独立的「开启提醒」按钮（B、C 同一个弹窗一次授权）。**不要**搭 `doAction` 的顺风车：那里刚弹过 `wx.showModal`，dismiss 动画未结束就压系统弹窗，iOS 有概率吞手势；且点「确认」问「取消通知」语义错配，用户会习惯性拒掉额度。

**额度语义：1 次授权 = 1 条消息**，可累积，额度为 0 时发送返回 `43101`。顾客侧精确匹配——`ACTION_MAP` 里 `confirm`/`reject` 的 `from` 都只含 `pending`，确认后再拒绝会被状态机挡掉，一次预约最多触发一次模板2。化妆师点一次「开启」顶一条，所以按钮文案是「开启 / 再开启一次」。**多个 admin 时额度是各自独立的** —— 每台手机都要各自点过一次「开启提醒」才收得到，她没点过就只是她那个 `43101`。`notifyEnabled` 只是 UI 提示，**不是服务端状态**，服务端不查它。

**模板 ID 在三处云函数各抄一份，不共享模块** —— `miniprogram/utils/notify.js`（客户端）+ `createBooking` + `adminUpdateBooking` + `cancelBooking`（`miniprogram/utils` 不在云函数文件系统里，反之亦然；共享只能靠人工复制进每个部署目录，漏复制 = 加载期崩溃）。字段的 key（`thing20`/`time2`/`phrase5`/…）必须与公众平台模板详情页**逐字一致**，key 错了消息静默发不出去。`thing` 上限 20 字、`phrase` 纯中文且 ≤5 字，所以「已确认」「已拒绝」都能放进 `phrase5`。`thing6` 温馨提示按结果分派两条（确认「预约已确认，请准时到店」11 字 / 拒绝「化妆师临时有事，具体原因请与化妆师联系」19 字，都未触顶）；化妆师侧的 `thing9`/`thing13` 同理是固定文案。**都不要塞 `booking.remark`**（上限 500 字会撑爆 20）。

**`sendSubscribeMessage()` 永远不抛** —— 这是「通知失败不影响预约」的**结构性保证**，不是偷懒：三个云函数各自被一个大 try/catch 包着（`createBooking` 里那个 catch 还负责 `add()` 失败时回滚时段占用），helper 一旦被换成裸的 `cloud.openapi.subscribeMessage.send(...)`，发送失败就会冒泡进那个 catch，把一条**已成功的**预约报成「服务器错误」。调用方可以无脑 `await`。

化妆师 openid 由 `findArtistOpenids()` 实时查 `users.where({admin: true})` 得到，**不缓存** —— `adminLogout` 把 `admin` 置 false 后缓存副本会继续给她发消息。这个字段只在这里被服务端读取，绝不进 `userProfile` 的白名单或 `get` 响应；openid 绝不返回给客户端。

**可以有多个 admin**：多个微信号都输过密码就会有多条 `admin: true`，**她们都要收到通知** —— 所以这里返回数组、**不能 `limit(1)`**（那会随机只通知其中一个，其中一人永远收不到）。`data` 只拼一次，在 `touser` 上分叉后用 `Promise.all` 并发发；因为 `sendSubscribeMessage` 永不抛，其中一人没授权（`43101`）不影响其他人收到。`limit(100)` 只是防呆，另做了 `_openid` 去重防止脏数据导致同一人收两条。

**`MINI_STATE` 决定订阅消息卡片点开后打开哪个版本**，三个云函数各抄一份：测试期 `'trial'`（体验版，体验成员随时能打开）；**正式上线前必须改成 `'formal'` 并重新部署三个函数**，否则线上普通顾客打不开。**绝不要用 `'developer'` 给顾客测** —— 开发版只在开发者工具扫码时有效、几分钟就过期，点卡片会提示「开发版小程序已过期，请在开发者工具中重新扫码」，而这个报错与通知本身发没发出去毫无关系，极易误判成发送失败。

三个云函数目录各有一份 `config.json` 声明 `permissions.openapi: ["subscribeMessage.send"]`。**`config.json` 只在上传时被读取**（必须选「上传并部署：云端安装依赖」），且权限有**约 10 分钟服务端缓存** —— 改完立刻测报「无权限」是正常的，别在这段时间里 debug。

**排障入口：云开发控制台 → 云函数 → 日志 → 搜 `subscribeMessage`。** 用户在公众平台改了模板是头号故障源（症状是通知全收不到但预约功能完全正常，且**永远不会暴露给用户**，只出现在日志里）：删模板 → `40037`；改字段名 → key 变了 → `47003`；加字段 → 没传 → `47004`（**整条发不出去**）；`code=43101` 则是额度用尽/没授权，业务正常不用改代码；`-501001` 是 config.json 权限没生效。DevTools 模拟器不弹真授权窗，控制台「云端测试」调 `subscribeMessage.send` 返回 `-501001` 是**预期的假阳性**（不带小程序云调用上下文）——端到端只能真机验证。

### Auth model

- **Customers**: identity is the server-side `OPENID` only, via `cloud.getWXContext()` with a fallback to the `context` arg of `exports.main`. It is never accepted from `event`. Ownership is enforced server-side (`booking._openid !== openid`). The shared helper is copy-pasted into each function rather than shared — keep that convention.
- **Admin**: `adminLogin` checks a password and issues a 7-day HMAC-SHA256 token (`base64({exp}).sig`). The password (`ADMIN_PASSWORD`) and secret (`TOKEN_SECRET`) live in `process.env` with hardcoded fallbacks. Every `admin*` function carries a duplicated `verifyAdmin()` block; all admin calls pass `token` from `wx.getStorageSync('admin_token')`.
- **Known admin weaknesses (accepted, not yet fixed)**: the token payload carries **no identity** — it is `{exp}` only, so it is a bearer token (steal it and you have admin for up to 7 days) and there is no attribution between artists. Password changes don't revoke already-issued tokens. Fixing this means putting the openid in the payload and having `verifyAdmin` cross-check `users[openid].admin === true`. The `users.admin` flag added for passwordless entry does **not** close this on its own — it is a UX/identity-memory feature, not an auth-bound one.

## Commands

No build, lint, or test tooling exists in this repo.

Deploy all cloud functions (needs `npm i -g @cloudbase/cli`):
```bash
./uploadCloudFunction.sh cloudfunctions <envId>   # envId must match miniprogram/app.js
```

Deploy one function during development (right-click the function dir in DevTools → 上传并部署：云端安装依赖).

Run/preview: open the directory in WeChat DevTools (`project.config.json`, appid `wx66cb29bc53a16600`). The DevTools must be logged into a WeChat account or every function returns `NO_OPENID`. Use the `whoami` function to diagnose openid/context problems.

After changing `miniprogram/app.js` env or any cloud function, redeploy the functions before testing — stale deployments are the usual cause of "worked locally, fails in DevTools".
