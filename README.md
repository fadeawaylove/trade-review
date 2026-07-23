# Trade Review Cloud

交易详情支持图表证据附件：每笔交易最多 5 张 PNG、JPEG 或 WebP，可选择文件、点击读取剪贴板或直接按 `Ctrl+V` 粘贴。单张最大 1.7 MB，较大的图片由浏览器自动压缩，文件存入受 GitHub 登录保护的 Cloudflare D1。

交易记录采用可恢复删除：移入回收站后不再参与任何统计，恢复时会连同原有文字补充和图表证据一起回来。

点击交易记录会在当前标签页打开全屏复盘空间。桌面端重点展示大幅图表证据与交易摘要，复盘表单位于下方；支持上一笔、下一笔、浏览器返回和固定保存入口，返回总览后保留筛选与滚动位置。

站点提供与页面 TR 印章一致的 SVG 标签页图标、PNG 兼容图标、Apple Touch 图标及 Web App Manifest。

私人期货日内交易复盘台的公开程序仓库。

## 隐私边界

- `docs/` 只包含静态界面，不包含交易记录；
- 交易数据存储在 Cloudflare D1；
- Worker 使用 GitHub OAuth 验证身份，并只允许配置的 GitHub 账号白名单；
- `ALLOWED_GITHUB_LOGIN` / `EDITOR_GITHUB_LOGINS` 配置可编辑账号，`READ_ONLY_GITHUB_LOGINS` 配置只读浏览账号；
- OAuth Client Secret 与 JWT Secret 仅存储为 Cloudflare Worker secrets；
- 本仓库不得提交 seed SQL、截图、本地 JSON、Excel 或嵌入交易数据的 HTML。

## 结构

- `docs/`：GitHub Pages 前端；
- `worker/src/index.js`：身份验证及交易 API；
- `worker/schema.sql`：D1 数据库结构；
- `wrangler.jsonc`：Cloudflare Worker 配置；
- `.github/workflows/pages.yml`：GitHub Pages 自动部署。

## 部署顺序

1. 创建 D1 数据库并把数据库 ID 写入 `wrangler.jsonc`；
2. 执行 `worker/schema.sql`；
3. 配置 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`JWT_SECRET`；
4. 部署 Worker；
5. 将 Worker URL 写入 `docs/config.js`；
6. 推送到 GitHub，触发 Pages 部署；
7. 使用本地生成的临时 seed SQL 初始化 D1。
