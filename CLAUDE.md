# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A WeChat Mini Program (微信小程序) for a makeup artist's appointment booking (化妆预约). Customers pick a date + one of three time slots and submit a booking from the home page (首页); the makeup artist (admin) opens/closes slots per date and manages booking status from admin pages reached through the 个人中心 page. All data lives in WeChat Cloud Development (云开发) — there is no server of its own and no build step.

## Architecture

Two halves that talk only through cloud functions:

- **Mini program** (`miniprogram/`) — plain WXML/WXSS/JS, no framework, no npm, no custom components. Pages are registered in `miniprogram/app.json` (`pages/index`, `pages/profile`, `pages/admin`, `pages/adminSlots`, `pages/adminStyles`) and nothing else may be added there without registering it. Static images live in `miniprogram/images/` (currently only the tabBar icons). WeChat's cloud quickstart leftovers (`pages/example`, `components/cloudTipModal`, `envList.js`, `images/`) were moved to `delete/` — see that folder's README; the tabBar icons in `images/tabbar/` were copied from there and recolored to the project palette with Pillow.

### Tab bar

`app.json` defines a native two-item tabBar: `pages/index/index` (首页) and `pages/profile/profile` (个人中心). Tab pages are cached, so their `onLoad` runs only once — anything that must refresh on every visit belongs in `onShow` (`index` already reloads there). Navigate **between** tab pages with `wx.switchTab` only; `wx.navigateTo` fails on a tab page. The admin pages are not tabs and are reached from 个人中心 via `wx.navigateTo`.
- **Cloud functions** (`cloudfunctions/<name>/index.js`) — one directory per function, each with its own `package.json` depending on `wx-server-sdk ~2.6.3`. Every function starts with `cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })`; the env ID is hardcoded once in `miniprogram/app.js` (`globalData.env`).

There is no custom component anywhere in the project.

### Cloud database collections

- `timeSlots` — one doc per `date` (`YYYY-MM-DD`) with fields `morning`/`afternoon`/`evening`, each `{ open, booked, done, styles? }` where `styles` is a list of `{ name, price }` (the 妆造 options offered for that slot). Created lazily by `adminSetTimeSlot` (all other slots default closed).
- `bookings` — one doc per appointment: `_openid`, `date`, `slot`, `slotName`, `name`, `skinType`, `remark`, `styleName`, `stylePrice`, `status`, `createTime`, `updateTime`.
- `users` — one doc per customer, keyed by `doc(openid)`: `_openid`, `avatarUrl`, `nickname`, `info`, `updateTime`. `info` is the 个人信息表 written by `pages/profile`: `gender`, `skinType`, `sensitiveLevel`, `hasAcne`, `hasCosmeticSurgery`, `hasAllergy`, `allergyNote`, `photos` (array of cloud-storage fileIDs, ≤ 5). Two fields are conditional and the server enforces it, not just the UI: `sensitiveLevel` is kept only while `skinType === '敏感性'`, and `allergyNote` only while `hasAllergy === '有'` — a stale free-text value is dropped whenever its parent toggle turns off. **This collection must be created manually in the cloud console** (permission: 仅创建者可读写) — the function turns the resulting `-502005` into a readable message but cannot create it itself.

### Customer profile (头像/昵称/个人信息表)

`pages/profile` renders the WeChat avatar and nickname: `<button open-type="chooseAvatar">` and `<input type="nickname">` (both need 基础库 ≥ 2.21.2). The avatar temp path from `chooseAvatar` is uploaded to cloud storage immediately (`avatars/<timestamp>-<rand>.<ext>`) and only the resulting `fileID` is kept — the temp path is not durable. Bare-face photos go to `bareface/<timestamp>-<i>-<rand>.<ext>`, max 5, via `wx.chooseMedia`.

The `users` doc is the source of truth; `wx.setStorageSync('user_profile' / 'user_info', …)` are render caches only, to make the page open instantly.

Two `userProfile` actions write the doc, and they must stay separate: `save` (avatar + nickname) and `saveInfo` (the form). The form does **not** edit 昵称 — it shows the header's nickname as read-only text, because the two fields are the same `nickname` in the doc and letting both edit it invites drift. `openInfo` seeds `form.nickname` from the header so the display is never stale. All enum values are whitelisted server-side, and `photos` entries that are not `cloud://`/`http(s)://` URLs are dropped.

**`doc().set()` replaces the whole document — never use it to update a single field here.** The header save originally did, which silently wiped the form. Both actions now read first (`readDoc`) and use `update({ data })` when the doc exists, falling back to `set` to create it. Also note: cloud-function-side `set`/`update`/`add` all require the `{ data: {...} }` wrapper; passing bare fields fails with `parameter.data should be object instead of undefined`.

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

## Commands

No build, lint, or test tooling exists in this repo.

Deploy all cloud functions (needs `npm i -g @cloudbase/cli`):
```bash
./uploadCloudFunction.sh cloudfunctions <envId>   # envId must match miniprogram/app.js
```

Deploy one function during development (right-click the function dir in DevTools → 上传并部署：云端安装依赖).

Run/preview: open the directory in WeChat DevTools (`project.config.json`, appid `wx66cb29bc53a16600`). The DevTools must be logged into a WeChat account or every function returns `NO_OPENID`. Use the `whoami` function to diagnose openid/context problems.

After changing `miniprogram/app.js` env or any cloud function, redeploy the functions before testing — stale deployments are the usual cause of "worked locally, fails in DevTools".
