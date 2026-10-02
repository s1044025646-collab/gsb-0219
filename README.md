# EPUB 电子书目录与资源一致性检查服务

一个 Windows 本地可运行的 EPUB 3 结构检查后端（TypeScript + Node.js + SQLite），只提供 API 与 CLI，无界面。导入未加密的 EPUB 3 文件后，可查看书名、作者、语言、章节阅读顺序（spine）与导航目录树（nav），并对包描述、阅读顺序、目录之间的引用一致性生成可定位到包内路径的问题报告。

## 支持的 EPUB 子集（明确边界）

- 未加密的 EPUB 3（ZIP 容器）：从 `META-INF/container.xml` 定位 OPF，读取 `manifest` / `spine` / `dc:title` / `dc:creator` / `dc:language`。
- 导航文档：manifest 中带 `properties="nav"` 的 XHTML，解析 `epub:type="toc"` 的 `<nav>` 内嵌套 `<ol>/<li>/<a>` 目录树。
- 相对路径以其所在文件的目录为基准解析；带 `#片段` 的导航链接先核对目标文件存在，再核对目标文件内是否存在对应 `id` 锚点。
- 目录嵌套顺序与 spine 阅读顺序分别保存，不假设二者一致。
- 远程链接（`http(s):` 等）只标注为 info，不发起任何网络访问。
- 包路径越界（`../` 超出包根）直接拒绝并记为错误。

**不做**：排版渲染、全文检索、电子书编辑、DRM 解密、网络资源抓取、完整 EPUBCheck 官方一致性测试、字体嵌入与媒体兼容检查、复杂样式检查。

## 检查项与严重级别

| 代码 | 级别 | 含义 |
| --- | --- | --- |
| `RESOURCE_MISSING` | error | manifest 声明的资源在包内不存在 |
| `DUPLICATE_ITEM_ID` | error | manifest 中重复的资源 ID |
| `SPINE_IDREF_MISSING` | error | spine 引用了不存在的 manifest ID |
| `NAV_MISSING` | error | 声明的导航文档不存在 |
| `NAV_LINK_TARGET_MISSING` | error | 导航链接目标文件不存在 |
| `NAV_ANCHOR_MISSING` | error | 导航链接的 `#锚点` 在目标文件中不存在 |
| `PATH_TRAVERSAL` | error | 相对路径越出包根目录 |
| `NAV_PARSE` | error | 导航文档 XML 无法解析 |
| `REMOTE_RESOURCE` / `REMOTE_LINK` | info | 远程资源/链接，仅标注不访问 |

每条问题都带 `file`（包内路径）与 `ref`（引用值）。导入/解析阶段的致命问题（坏 ZIP、缺 container.xml、缺 OPF、XML 无法解析）以错误码抛出，**不会导致服务退出**。

## 错误码

`INVALID_ARGUMENT`（参数缺失/非法）、`NOT_FOUND`（书籍/检查/文件不存在）、`INVALID_ZIP`、`INVALID_XML`、`CONTAINER_MISSING`、`OPF_MISSING`、`PATH_TRAVERSAL`、`INTERNAL`。API 统一返回 `{"error":{"code","message"}}` 与对应 HTTP 状态码。

## 环境要求

- Windows + Node.js ≥ 22（使用内置 `node:sqlite`，无需原生编译、无需 Docker/WSL）。
- 依赖：`jszip`、`fast-xml-parser`（运行时）；`typescript`、`tsx`（开发）。

## 可复现命令

```powershell
npm install              # 安装依赖
npm run build            # 编译 TypeScript 到 dist/
npm test                 # 编译并运行全部测试（14 个用例）
npm run make-samples     # 生成 samples/ 下 1 个合法 + 4 个故障样例
npm run demo             # 端到端演示：导入 → 章节 → 导航 → 检查 → 导出报告
npm start                # 启动 API 服务（默认自动选择空闲端口）
```

CLI 也可以直接用 `npm run cli -- <命令>`（tsx 免构建）或构建后 `node dist/cli.js <命令>`：

```powershell
node dist/cli.js serve --port 8080        # 指定端口；缺省 --port 0 表示自动选空闲端口
node dist/cli.js import samples/valid.epub
node dist/cli.js list
node dist/cli.js chapters 1               # 章节阅读顺序（spine）
node dist/cli.js nav 1                    # 导航目录树（嵌套保留）
node dist/cli.js check 1                  # 运行检查，返回 checkId
node dist/cli.js issues 1 --severity error
node dist/cli.js report 1 --out report.json
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/books` | 导入，body `{"path": "samples/valid.epub"}`；同内容（SHA-256）重复导入返回 `duplicate: true` 与原 bookId |
| GET | `/api/books` / `/api/books/:id` | 列表 / 详情 |
| GET | `/api/books/:id/chapters` | 章节阅读顺序 |
| GET | `/api/books/:id/nav` | 导航目录树 |
| POST | `/api/books/:id/checks` | 运行检查（不改写源文件） |
| GET | `/api/books/:id/checks` | 某书的检查历史 |
| GET | `/api/checks/:id/issues?severity=error&code=...` | 筛选问题 |
| GET | `/api/checks/:id/report` | JSON 报告（含 error/warning/info 汇总） |

## 数据目录

默认 `./data`（可用环境变量 `EPUB_CHECK_DATA` 覆盖）：

- `data/app.db`：SQLite，保存书籍（SHA-256 摘要、元数据、spine/manifest/nav 结构摘要）、检查记录与问题。
- `data/books/<sha256>.epub`：导入时复制的原文件，重新检查只读取、不改写。

## 样例

`npm run make-samples` 生成（均为中文标题、两级目录、章节锚点）：

- `samples/valid.epub`：合法样例（含一个仅标注的远程链接）。
- `samples/missing-resource.epub`：manifest 声明了不存在的 `images/cover.png`。
- `samples/bad-spine.epub`：spine 引用不存在的 `ch-ghost`。
- `samples/bad-relative-path.epub`：导航链接 `chapter1.xhtml` 相对路径错误（应为 `text/chapter1.xhtml`）。
- `samples/missing-anchor.epub`：导航链接 `#sec-nope` 锚点不存在。

## 已知限制

- 锚点核对通过扫描目标 XHTML 中的 `id="..."` 属性实现，不解析完整的 HTML 语义。
- 仅支持单 rootfile；`epub:type="toc"` 之外的 nav（page-list、landmarks）暂不解析。
- `node:sqlite` 在 Node 25 仍带 Experimental 警告，功能可用；如需消除可替换为 better-sqlite3。
