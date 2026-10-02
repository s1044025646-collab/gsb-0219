# EPUB 电子书目录与资源一致性检查服务（epubchk）

一个纯本地运行的 EPUB 3 结构检查后端：导入未加密 EPUB，读取书名/作者/语言、章节阅读顺序（spine）与导航目录（nav），并对包描述、阅读顺序、目录之间的引用一致性生成可定位到包内路径的问题报告。提供 HTTP API 与 CLI 两种使用方式，数据保存在项目内 SQLite 与数据目录中。

技术栈：TypeScript + Node.js（CommonJS）+ better-sqlite3（SQLite）+ adm-zip（ZIP）+ fast-xml-parser（XML）。无 Docker / WSL / 外部在线 API 依赖。

## 快速开始

```powershell
npm install        # 安装依赖（better-sqlite3 使用预编译二进制）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
```

## 演示流程（可复现）

```powershell
npm run build
node dist/src/cli.js make-samples                      # 生成 1 个合法 + 4 个损坏样例到 samples/
node dist/src/cli.js import samples\valid-sample.epub  # 导入合法样例 -> bookId 1
node dist/src/cli.js import samples\valid-sample.epub  # 重复导入 -> duplicate: true，同一 bookId
node dist/src/cli.js chapters 1                        # 章节阅读顺序（spine）
node dist/src/cli.js nav 1                             # 两级导航目录树
node dist/src/cli.js import samples\broken-missing-anchor.epub
node dist/src/cli.js check 2                           # 运行检查
node dist/src/cli.js issues 2 --severity error         # 只看错误
node dist/src/cli.js report 2 --out report.json        # 导出 JSON 报告
node dist/src/cli.js serve --port 8080                 # 启动 API（省略 --port 则自动选空闲端口）
```

## CLI 命令

| 命令 | 说明 |
| --- | --- |
| `import <file.epub>` | 导入电子书；同一内容（SHA-256）重复导入返回已有记录并标记 `duplicate: true` |
| `list` | 列出已导入书籍 |
| `chapters <bookId>` | 章节阅读顺序（spine 顺序，与目录嵌套顺序分别保留） |
| `nav <bookId>` | 导航目录树（保留嵌套层级） |
| `check <bookId>` | 重新打开包内副本运行检查（不改写源文件），结果入库 |
| `checks <bookId>` | 历史检查记录 |
| `issues <bookId> [--severity error\|warning\|info] [--code CODE]` | 筛选最近一次检查的问题 |
| `report <bookId> [--out file]` | 导出最近一次检查的 JSON 报告 |
| `serve [--port N]` | 启动 HTTP API；`--port 0` 或省略时自动选择空闲端口 |
| `make-samples [dir]` | 生成演示样例 |

全局参数：`--data-dir <dir>` 指定数据目录（默认 `./data`，也可用环境变量 `EPUBCHECK_DATA_DIR`）。

## HTTP API

默认监听 `127.0.0.1`，端口可配（默认 0 = 自动选空闲端口，启动日志打印实际端口）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /books` | 导入，请求体 `{"path": "C:/path/book.epub"}` |
| `GET /books` / `GET /books/:id` | 列表 / 详情 |
| `GET /books/:id/chapters` | 章节阅读顺序 |
| `GET /books/:id/nav` | 导航目录树 |
| `POST /books/:id/checks` | 运行检查并返回报告 |
| `GET /books/:id/checks` | 历史检查记录 |
| `GET /books/:id/issues?severity=&code=` | 筛选最近一次检查的问题 |
| `GET /books/:id/report` | 最近一次检查的完整报告 |

错误响应统一为 `{"error": {"code": "...", "message": "..."}}`，错误码包括：`INVALID_PARAM`、`BOOK_NOT_FOUND`、`CHECK_NOT_FOUND`、`FILE_NOT_FOUND`、`ZIP_INVALID`、`CONTAINER_MISSING`、`CONTAINER_PARSE_ERROR`、`OPF_NOT_FOUND`、`OPF_PARSE_ERROR`、`PATH_TRAVERSAL`、`XML_PARSE_ERROR`、`INTERNAL`。单本坏书只返回错误响应，不会使服务退出。

## 实际支持的 EPUB 子集与检查项

面向未加密的 EPUB 3（也能读取大部分 EPUB 2 结构，但不保证完整兼容）：

- 从 `META-INF/container.xml` 定位第一个 rootfile 的 OPF；读取 `dc:title` / `dc:creator` / `dc:language`、manifest、spine。
- 相对路径一律以**引用它所在的文件目录**为基准解析（manifest href 相对 OPF，nav 链接相对 nav 文档），规范化后拒绝越出包根的路径（`PATH_TRAVERSAL`）。
- 导航文档取 manifest 中 `properties="nav"` 的项，解析 `epub:type="toc"` 的 `ol/li/a` 嵌套结构；目录嵌套顺序与 spine 阅读顺序分别保存，不视为相同。
- 检查项：
  - `DUP_MANIFEST_ID`（error）：manifest 重复资源 id
  - `RESOURCE_MISSING`（error）：manifest 声明的资源在包内不存在
  - `SPINE_IDREF_MISSING`（error）：spine 引用不存在的 manifest id
  - `NAV_MISSING` / `NAV_EMPTY`（warning）、`NAV_NOT_FOUND` / `NAV_PARSE_ERROR`（error）
  - `NAV_TARGET_MISSING`（error）：导航链接目标文件不存在（先核对文件）
  - `NAV_ANCHOR_MISSING`（error）：带 `#fragment` 的链接，目标文件存在但锚点 id 不存在（再核对锚点）
  - `NAV_LINK_EMPTY`（warning）：目录项无链接
  - `REMOTE_LINK`（info）：`http(s)://` 等远程链接只标注，**不发起任何网络访问**
- 每条问题包含 `severity`（error=妨碍读取 / warning / info=提示）、`code`、`message`、`filePath`（问题所在的包内路径）、`refValue`（相关引用值）。
- 拒绝无法解析的 ZIP、缺失/损坏的 container.xml 与 OPF、含越界路径的 ZIP 条目。

明确**不做**：排版渲染、全文检索、电子书编辑、DRM 解密、网络资源抓取、CSS/字体嵌入/媒体兼容性检查，也不是完整的 EPUBCheck 官方一致性套件。

## 数据与存储

- 数据目录（默认 `./data`）：`data/epubcheck.db`（SQLite：books / checks / issues 三表）与 `data/books/<sha256>.epub`（导入文件的内容寻址副本）。
- 书籍记录保存原文件 SHA-256 摘要与结构摘要（manifest、spine、导航树、包内条目清单，JSON）。
- 每次 `check` 生成一条新的检查记录与问题明细，可多次重复；检查只读取包内副本，从不修改源文件。
- 重启服务后可直接查看既有书籍与历史报告（有对应测试覆盖）。

## 样例

`make-samples` 生成（均为中文标题、两级目录、章节内锚点）：

- `valid-sample.epub`：完全合法，检查应 0 错误
- `broken-missing-resource.epub`：删除了 manifest 声明的 `css/style.css` → `RESOURCE_MISSING`
- `broken-spine-ref.epub`：spine 多了 `<itemref idref="ch99"/>` → `SPINE_IDREF_MISSING`
- `broken-wrong-path.epub`：nav 中第二章链接写成 `text/chapter2.xhtml` → `NAV_TARGET_MISSING`
- `broken-missing-anchor.epub`：nav 链接 `text/ch3.xhtml#s99` 锚点不存在 → `NAV_ANCHOR_MISSING`

## 测试

```powershell
npm test
```

覆盖：固定章节顺序、两级导航嵌套、带片段链接（先文件后锚点）、缺资源 / 坏 spine / 错误相对路径 / 缺锚点的问题定位、损坏 ZIP、路径越界、远程链接仅标注、重复导入、重新检查不改写源文件、服务重启后查看既有报告、severity/code 筛选、HTTP API 全链路与参数校验。

## 已知限制

- XML 解析做了命名空间前缀归一化，极端非常规写法（如多层嵌套同名 nav）可能解析不完整。
- 锚点存在性通过正则提取 `id="..."` 判断，不验证 XHTML 语义合法性。
- 仅监听 `127.0.0.1`，无认证，设计为单机本地工具。
