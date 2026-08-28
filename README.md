# Trade Review Cloud

交易详情支持图表证据附件：每笔交易最多 5 张 PNG、JPEG 或 WebP，可选择文件、点击读取剪贴板或直接按 `Ctrl+V` 粘贴。单张最大 1.7 MB，较大的图片由浏览器自动压缩，文件存入受 GitHub 登录保护的 Cloudflare D1。

交易记录采用可恢复删除：移入回收站后不再参与任何统计，恢复时会连同原有文字补充和图表证据一起回来。

点击交易记录会在当前标签页打开全屏复盘空间。桌面端重点展示大幅图表证据与交易摘要，复盘表单位于下方；支持前一笔、后一笔、浏览器返回和固定保存入口，返回总览后保留筛选与滚动位置。

站点包含独立的私有 Markdown 写作工作台。工作副本、显式检查点、图片和关联交易均保存在 D1；支持导入与导出 `.md`、标签筛选、软删除恢复，以及从手记和交易复盘两侧相互跳转。Markdown 渲染默认不执行原生 HTML，外部图片不会直接嵌入。

`journal/` 是独立部署到 Cloudflare Workers 的 Astro SSR 公开手记。它只读取当前发布快照，不提供私密 JSON 接口；未发布修改、审计记录、登录身份、交易编号和未被当前快照引用的图片都不会进入公开响应。

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
- `worker/schema.sql`：当前 D1 结构参考与测试基准，不作为部署入口；
- `worker/migrations/`：新库与已上线数据库统一使用的有序迁移；
- `journal/`：Astro SSR 公开手记 Worker；
- `wrangler.jsonc`：Cloudflare Worker 配置；
- `.github/workflows/pages.yml`：GitHub Pages 自动部署。

## 部署顺序

1. 创建 D1 数据库并把数据库 ID 写入两个 Worker 的 Wrangler 配置；不要预先执行 `worker/schema.sql`；
2. 使用 Node.js 22.12.0 或更高版本，运行 `npm --prefix cloud ci` 与 `npm --prefix cloud/journal ci` 安装两处锁定依赖；
3. 配置 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`JWT_SECRET`；
4. 在仓库根目录运行 `npm run publish:cloud`；发布器会应用尚未执行的 D1 migration；
5. 发布器依次部署私密 API Worker、公开手记 Worker，并将 `docs/` 同步至 Pages 部署仓库；
6. 首次部署后将 API Worker URL 写入 `docs/config.js`，按需为公开手记绑定自定义域名；
7. 新库和日常升级都只运行 `wrangler d1 migrations apply`（发布器会自动执行）；`worker/schema.sql` 仅用于结构参考和测试，不得在 migrations 前执行。

`npm run check:publish` 只执行本地依赖/构建检查并只读克隆 Pages 部署仓库；它不会运行远程 D1 migration、部署 Worker、提交或推送。Pages 同步会递归排除 `journal/`、`node_modules/`、Wrangler 本地状态、私有配置和任何 seed SQL。
