# TryOn Lab

本地运行的虚拟试穿工作台，使用 Decart 官方 API，支持图片换装、短视频换装、相机实时接入和本地用量记录。

## 效果展示

![视频换装前后对比，六个画面中的人脸均已遮挡](docs/assets/tryon-comparison-redacted.png)

上排为输入视频画面，下排为换装结果。此图由维护者明确授权公开，已遮挡人脸；仅展示一次测试的效果，不代表所有素材均能达到相同质量。

## 功能

围绕“选人物、选服装、生成试穿、查看结果”的流程，TryOn Lab 将图片、短视频和相机实时换装集中在同一个网页工作台，并提供结果下载与用量记录，方便快速验证不同服装的上身效果。

- **一键换装**：人物照片与服装参考图，生成 720p 图片，原图/结果对比、下载。
- **视频试穿**：上传时长大于 0 且不超过 20 秒的 MP4，查询任务、播放及下载结果。
- **相机实时试穿**：本地相机预览、实时云端输出、10/20/30 秒时限、停止与截图。
- **本次截图**：预览、PNG 下载和删除；刷新页面后清空。
- **账单用量**：SQLite 保存本地调用记录；平台实际积分由用户核对后录入，与估算分开显示。

相机/视频使用 `lucy-vton-3.5`，图片使用 `lucy-image-2`。这是 API 客户端，不包含离线模型。生成效果、身份保持和细节准确度取决于供应商模型及输入素材。

## 环境

- Node.js 22.22 或更高版本；本次在 Node.js 22.22.3 验证。
- 已安装的 Chrome 或 Edge，用于手动使用网页；浏览器自动检查使用 Chrome。
- FFmpeg 和 ffprobe 可从命令行调用，用于校验图片/视频和生成测试视频。`FFPROBE_PATH` 可指定 ffprobe 可执行文件。
- 自己的 Decart API Key，以及可用的模型权限和额度。

## 启动

```sh
npm ci
cp .env.example .env
# 编辑 .env，填写自己的 DECART_API_KEY
npm run build
npm start
```

Windows PowerShell 可用 `Copy-Item .env.example .env` 复制配置模板。

打开 [http://127.0.0.1:4180](http://127.0.0.1:4180)。默认不会申请相机或自动生成，只有手动确认并开始才会调用生成接口。永久 Key 由后端读取，不进入前端构建。

如需把账单保存在项目之外，可设置 `BILLING_DB_PATH`。默认位置为 `data/billing.sqlite`。也可通过 Node 的 `--env-file` 参数加载项目之外的私有配置文件。不要提交真实配置、数据库或素材。

## 路由与数据

| 路由 | 功能 |
| --- | --- |
| `/#studio` | 相机实时试穿 |
| `/#image` | 图片一键换装 |
| `/#video` | 上传视频换装 |
| `/#results` | 当前页面内存中的截图 |
| `/#billing` | 本地调用账本与手工平台核对值 |
| `/#settings` | 接入说明 |

输入图片每张最多 10 MiB、1600 万像素，支持 JPEG/PNG/WebP。上传视频最多 50 MiB、20 秒、4K 总像素，要求 MP4（H.264/VP8）；不自动转码。后台用 ffprobe 检查真实文件，校验临时文件在正常结束后清理。

当前生成结果缓存于后端内存，重启后会丢失，请及时下载。账单记录单独持久化到 SQLite。平台积分没有自动同步接口接入，页面上的官方数值是用户手工核对快照，不是实时余额。本地估算不能当作平台实际扣费。

## 验证

```sh
npm run build
npm test
```

Node 测试使用本地测试素材及模拟供应商，不需要真实 Key，不调用付费生成。媒体校验测试需要 FFmpeg/ffprobe。

浏览器检查还需要在另一个终端启动 `npm start`，然后运行：

```sh
node test/browser-check.mjs
node test/video-browser-check.mjs
node test/image-browser-check.mjs
node test/billing-browser-check.mjs
```

这些脚本使用声明在开发依赖中的 Playwright 和已安装 Chrome，拦截生成请求；相机测试使用测试流。`PLAYWRIGHT_MODULE` 可覆盖 Playwright 模块位置，通常无需设置。临时输出在被忽略的 `work/`，浏览器账单测试使用模拟数据，不写入真实账本。

## 代码结构

```text
src/                  页面、样式、相机/图片/视频/账单交互
server.mjs            本地静态服务、来源校验、短期凭证
video-jobs.mjs        视频校验、任务提交、状态和结果
image-generation.mjs 图片校验、生成和结果缓存
billing.mjs           SQLite 调用记录和手工核对快照
build.mjs             esbuild 前端构建
test/                 Node 测试、浏览器检查、合成测试图片
docs/                 功能约定和安全说明
```

## 使用边界

当前版本适合个人试用与效果验证，尚未提供多人账号和访问认证；如需对外提供服务，应先补齐访问控制并妥善保护 API Key。生成会消耗供应商额度，价格以[官方定价](https://docs.platform.decart.ai/getting-started/pricing)为准。离开网页不代表已提交的视频/图片任务被取消。

实时连接中停止会清理上传轨道并丢弃迟到结果；SDK 连接 Promise 没有公开的取消句柄，因此不能保证平台计费在点击停止时零延迟结束。手工本地次数限制不是账号级硬预算。

## 许可

源代码采用 [MIT License](LICENSE)。第三方依赖保留各自许可；使用 Decart 云端服务需要遵循其服务条款并承担调用费用。除明确授权的遮脸展示图外，本仓库不包含私人原始媒体、真实 API Key、账号账单或逆向分析产物。
