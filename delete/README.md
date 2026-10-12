# delete/

这里是从项目中移除但保留的微信云开发脚手架（quickstart）模板文件，运行时不会被打包或加载，
仅在需要查阅官方示例代码时参考。确认不再需要后可直接删除整个目录。

## 内容

| 原路径 | 说明 |
| --- | --- |
| `miniprogram/pages-example/` | 微信官方云开发示例页，**从未在 `app.json` 中注册**，无法访问 |
| `miniprogram/components/cloudTipModal/` | 仅被上面的示例页使用 |
| `miniprogram/envList.js` | 仅被示例页使用（云环境 ID 的硬编码副本，真实值在 `miniprogram/app.js`） |
| `miniprogram/images/` | 1.3 MB 模板图片，业务页面一张都没用到 |
| `cloudfunctions/listMyBookings/` | 云函数。首页原本每次 `onShow` 会并行调 `listWeekSchedule` + `listMyBookings` 两个函数、两次冷启动。现已改为由 `listWeekSchedule` 一次返回网格和「我的预约」所需的全部数据，本函数不再被新代码调用 |

注意：本目录内的路径已不反映原始位置，恢复时请移回 `miniprogram/` 下对应位置。

## 待你手动删除

`cloudfunctions/listMyBookings/` 移到此处只是让它不再随
`./uploadCloudFunction.sh` 重新部署，**云端那份函数还在，仍可被调用**。
需要你到云开发控制台手动删除：

- 云函数 → `listMyBookings` → 删除

删之前先确认没有旧版本小程序还在调它 —— 已发布出去的旧版本代码里
`pages/index` 仍写着 `wx.cloud.callFunction({ name: 'listMyBookings' })`。
微信的旧版本会一直存在到用户主动更新，所以**建议先发一版新小程序、等主要
用户更新之后再删**。新版本已经不调它了。
