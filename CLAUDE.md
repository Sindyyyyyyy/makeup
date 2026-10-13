# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A WeChat Mini Program (微信小程序) for a makeup artist's appointment booking (化妆预约). Customers pick a date + one of three time slots and submit a booking from the home page (首页); the makeup artist (admin) opens/closes slots per date and manages booking status from the 化妆师后台, which occupies the *same* 首页 tab. All data lives in WeChat Cloud Development (云开发) — there is no server of its own and no build step.

## Architecture

Two halves that talk only through cloud functions:

- **Mini program** (`miniprogram/`) — plain WXML/WXSS/JS, no framework, no npm. Pages are registered in `miniprogram/app.json` (`pages/index`, `pages/profile`, `pages/adminLogin`, `pages/adminSlots`, `pages/adminStyles`) and nothing else may be added there without registering it. Shared UI lives in `miniprogram/components/` (`infoForm`, `adminPanel`); a page must declare them in its own `.json` `usingComponents`. A component directory's files must be named after the directory (`adminPanel/adminPanel.js`), **not** `index.js` — `usingComponents` paths are resolved literally. Static images live in `miniprogram/images/` (currently only the tabBar icons). WeChat's cloud quickstart leftovers (`pages/example`, `components/cloudTipModal`, `envList.js`, `images/`) were moved to `delete/` — see that folder's README; the tabBar icons in `images/tabbar/` were copied from there and recolored to the project palette with Pillow.

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

There is no custom component other than `components/infoForm` and `components/adminPanel`.

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

Per-slot 妆造 options and prices are configured by the admin in `adminSlots` and stored on the `timeSlots` doc, not on the booking. `createBooking` re-validates the chosen `styleName` against the slot's server-side list and **copies the price from the server** — the client never sends a price. If the slot has any styles configured, the customer must pick one.

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
