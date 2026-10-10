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

注意：本目录内的路径已不反映原始位置，恢复时请移回 `miniprogram/` 下对应位置。
