# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A WeChat Mini Program (微信小程序) for a makeup artist's appointment booking (化妆预约). Customers pick a date + one of three time slots and submit a booking; the makeup artist (admin) opens/closes slots per date and manages booking status from two admin pages. All data lives in WeChat Cloud Development (云开发) — there is no server of its own and no build step.

## Architecture

Two halves that talk only through cloud functions:

- **Mini program** (`miniprogram/`) — plain WXML/WXSS/JS, no framework, no npm, no bundled images. Pages are registered in `miniprogram/app.json` (`pages/index`, `pages/admin`, `pages/adminSlots`) and nothing else may be added there without registering it.
- **Cloud functions** (`cloudfunctions/<name>/index.js`) — one directory per function, each with its own `package.json` depending on `wx-server-sdk ~2.6.3`. Every function starts with `cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })`; the env ID is hardcoded once in `miniprogram/app.js` (`globalData.env`).

There is no `images/` directory and no custom components. WeChat's cloud quickstart leftovers (`pages/example`, `components/cloudTipModal`, `envList.js`, `images/`) were moved to `delete/` — see that folder's README.

### Cloud database collections

- `timeSlots` — one doc per `date` (`YYYY-MM-DD`) with fields `morning`/`afternoon`/`evening`, each `{ open: bool, booked: bool }`. Created lazily by `adminSetTimeSlot` (all other slots default closed).
- `bookings` — one doc per appointment: `_openid`, `date`, `slot`, `slotName`, `name`, `skinType`, `remark`, `status`, `createTime`, `updateTime`.

### Booking slot lifecycle

Three fixed slots per day are defined **twice** and must be kept in sync manually: `miniprogram/utils/slots.js` (`SLOT_DEFS` — the frontend source of truth) and the `SLOT_KEYS`/`SLOT_NAMES` constants at the top of each cloud function. Slot names are `'8-11点'`, `'14-17点'`, `'18-21点'`.

Status state machine (enforced in `adminUpdateBooking` via `ACTION_MAP`):
`pending → confirmed → completed`, plus `pending → rejected`. Customers cancel via `cancelBooking`.

Concurrency: `createBooking` claims a slot with a conditional single-document update (`{slot.open: true, slot.booked: false}` → `booked: true`) rather than read-then-write, and rolls the claim back if the `bookings` insert then fails. Preserve this if you refactor that path.

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
