# 终端云工作助手官网

独立 Node.js + TypeScript + Vue 3 项目，包含产品介绍、使用指南、更新说明与 Desktop 发布服务。它不承载 DSH 业务 Runtime，也不读取 DSH_HOME。

源码从 ops-harness 的 `src/website` 迁移，保留首页动效、真实截图、帮助文档、Vditor 管理员、目录与图片管理、安装包上传、changelog 和 Desktop 更新 API。迁移边界见 [ADR 0014](docs/adr/0014-standalone-website-repository.md)。安装与运行不需要产品仓库或 DSH。

## 本地运行

代码 clone 到新服务器后，请按 [Ubuntu / Debian 简明部署手册](docs/runbooks/website-deployment-ubuntu-debian.md) 完成环境安装、配置、构建与启动。

在仓库根目录执行（Node.js 24、pnpm 11.19.0）：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

需要管理员模式时，在执行 `pnpm dev` 前按 [维护手册](docs/runbooks/website-guide-maintenance.md#启用管理员模式) 从终端或部署环境注入密码；项目不保存默认密码。

默认访问 `http://127.0.0.1:4173`。开发时同一个 Node 进程处理 API 与 Vite，支持 Vue 热更新。

生产构建的本地预览：

```sh
pnpm build
pnpm start
```

公开页面为 `/`、`/guide`、`/releases`，官网管理员入口为 `/admin`。没有发布记录时，下载区显示“安装包准备中”，更新页展示 `content/development.json` 中明确标注的开发内容，不生成虚假下载链接。

## 首页与使用指南

- `client/HeroAtmosphere.vue`：参考 [DeepSeek Harness 官网](https://www.deepseek.com/harness/) 的蓝色光场与点阵空间感，自行实现 Canvas 动画。鼠标移动带动柔光、扩散涟漪与点阵视差/避让；支持暂停、系统减少动态效果偏好，以及离开可见区域/后台时停止刷新；不加载外部动画脚本。
- `client/WorkspacePreview.vue` / `ProductShot.vue`：首页仅展示“目标 · 待办”，以今日重点、日程、邮件和行动建议为介绍重点，支持查看原图。展示图保存在 `public/assets/product/`，由开发与生产服务统一提供 `/assets/product/` 路径。工具市场、我的技能、我的专家暂不在首页介绍，其既有指南内容与配图保留。
- `content/guide/*.md`：11 个独立 Markdown 章节，包含操作步骤、完成标志、示例与常见问题。更新功能时同步核对对应插件 README 和实际界面，不能将待接入能力描述为已经可用。
- `client/GuidePage.vue`：全文搜索、分组目录、前后章导航和示例复制。支持章节链接及原有 `#step-1` 至 `#step-4` 链接。

### 管理员与 Markdown 维护

管理员入口为 `/admin`。包含“文档编辑、目录与文档管理、发布包、图片库”四个区域。文档编辑页只编辑 Markdown 正文，提供文档选择、预览和正文历史恢复。目录与文档管理页以分组列表集中处理新建、名称与简介、移动、排序、隐藏及回收恢复，操作按钮直接显示。旧 `/guide/admin` 地址自动跳转到 `/admin`。完整操作、内容格式、部署凭据与备份方式见 [帮助文档维护手册](docs/runbooks/website-guide-maintenance.md)。选型比较见 [ADR 0012](docs/adr/0012-markdown-guide-administration.md)。

`client/GuideAdmin.vue` / `MarkdownEditor.vue` 提供管理员登录、Vditor 编辑、阅读预览、版本历史与回收站。管理员密码通过环境提供，没有默认密码；未配置时编辑接口关闭，公开阅读不受影响。日常保存发布到 `.runtime/website-content`。管理员可明确点击“同步到 content”，核对清单后将修改过的文档、目录和图片写回源码，以便检查并提交到主仓；不会自动执行 Git 操作。

编辑器仅在管理员页面加载，附属资源由 `scripts/prepare-assets.mjs` 从锁定的 npm 包复制到本站，生成目录不提交 Git。`scripts/copy-guide.mjs` 将 `content/guide`（包含 `navigation.json`）及 `content/media` 复制到生产构建中。图片继续使用 `/media/<sha256>.<ext>` 地址，在线目录没有该文件时读取构建中的图片。

### 产品展示图维护

首页 `goals-todos.jpg` 于 2026-09-17 使用产品仓库 `packages/features/my-todos/src/client.js` 的实际页面组件，在独立浏览器环境中注入固定示例数据后采集，尺寸为 1470 × 980。产品源码基线为 `128d494bb9a8114702ff131674efdf1b14228c2e`。页面标明“界面示例”，不读取真实账号、邮件、日程、会话或 Desktop 状态，不启动 DSH；官网运行不依赖产品源码或 React。当前介绍不承诺独立目标创建、关键结果或进度管理。

指南保留的三张 JPEG 于 2026-09-13 从产品仓库 ops-harness 完成 `pnpm local:bootstrap` 后的真实 Web Runtime 采集；源码基线为 `c75716f`，Profile 为 `web`，运行数据位于仓库 `.runtime/dsh-home`，访问地址为 `http://127.0.0.1:3081/`。图片尺寸均为 1470 × 746。

| 文件 | 实际采集页面 |
| --- | --- |
| tools.jpg | 工具市场 → 系统工具 → 网页抓取 |
| skills.jpg | SKILL 市场 → 我的技能 → 系统内置 |
| experts.jpg | 专家 → 我的专家 |

以上指南截图为浏览器内容原图，未用生成图片或重建 UI 替代。采集前折叠会话分组，避免展示私人会话标题；不得展示凭据、登录二维码、个人资料或敏感业务内容。页面中的工具状态与数量是该次运行的实际状态，不作为默认安装状态承诺。界面更新后按相同入口重新采集、检查内容并同步替换首页与指南共用的资源。

## 配置

官网统一使用本仓库根目录的 [`config/website.json`](config/website.json)，包含服务、发布存储、文档存储和管理员密码环境变量名称。也可通过 `DSH_OPS_WEBSITE_CONFIG` 指向另一份完整 JSON，开发服务、生产服务和发布 CLI 共用同一个配置入口。配置文件路径建议使用绝对路径；`releaseDirectory` 和 `contentDirectory` 都相对于该配置文件所在目录解析，也支持绝对路径。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| schemaVersion | 1 | 配置版本 |
| websiteUrl | http://127.0.0.1:4173 | 官网对外地址，须与 Desktop 客户端配置一致 |
| host | 127.0.0.1 | 服务监听地址 |
| port | 4173 | 监听端口 |
| releaseDirectory | ../.runtime/website-releases | 安装包和发布目录数据 |
| contentDirectory | ../.runtime/website-content | 在线文档、历史、目录配置和图片 |
| trackingEnabled | false；仓库配置显式 true | 是否接收运营打点，与启动方式及事件环境无关 |
| adminPasswordEnv | DSH_OPS_WEBSITE_ADMIN_PASSWORD | 注入管理员密码的环境变量名称，配置中不保存密码 |

从旧配置迁移时，将原 `config/releases.json` 和 `config/website-content.json` 的字段合并到一份 `website.json`，仅保留一个 `schemaVersion`。如果新文件位置改变，应同步调整两个存储目录的相对路径，确保仍指向原数据；无需移动在线内容或发布归档。将官网进程原来的 `DSH_OPS_RELEASE_CONFIG` / `DSH_OPS_WEBSITE_CONTENT_CONFIG` 替换为 `DSH_OPS_WEBSITE_CONFIG` 后重启。只设置旧变量时服务和 CLI 会提示迁移并停止，不会静默改用默认目录。密码环境变量保持原名称。配置修改需要重启服务才能生效。

`websiteUrl` 接受 HTTP 或 HTTPS 源地址，包括内网 IP 和域名，不接受账号密码、子路径、查询串或 fragment；填写纯 URL，不要使用 Markdown 链接格式。`host` 与 `port` 控制实际监听，默认仍为 loopback。内网直连可将 `websiteUrl` 设为 `http://7.192.170.132:4173`，`host` 设为服务器网卡上的 `7.192.170.132`，`port` 保持 `4173`；浏览器也必须使用完全相同的协议、地址与端口。管理员密码要求、Host/Origin、CSRF 和 revision 校验继续生效。HTTP 不加密传输，此方式用于受控内网；公网部署仍应由 HTTPS 网关提供 TLS，并保留 Node 服务的 loopback 监听。仅把 `websiteUrl` 改成 HTTPS 不会自动启用 TLS。

以后更换地址时修改此值并重启官网，同时更新产品 Bundle 的 `ops-workbench.config.websiteUrl` 并重新构建客户端；Desktop 从实际加载的 Workbench 配置读取地址，不再使用产品 `config/releases.json` 或 `DSH_OPS_RELEASE_CONFIG`。两边的协议、主机与端口必须一致。共享发布协议 0.1.1 已统一支持 HTTP 和 HTTPS，官网直接使用同一校验器。旧安装包仍执行原 HTTPS / loopback 限制，须通过旧版可用更新源或手动安装升级到包含此改动的客户端后，才能切换到非回环 HTTP 地址；官网修改不会自动迁移旧客户端地址。

## 发布安装包

网页操作：登录 `/admin` → 发布包 → 新建发布，先选择与安装包同一次打包生成的 `latest.yml`（macOS 为 `latest-mac.yml`）。服务端自动提取版本、平台、文件名、SHA-512 及可选的大小；填写标题和 changelog（每行一条），保存草稿后上传清单中的软件包。SHA-512 或描述文件中已提供的大小不匹配时拒收并清理此次临时文件，校验通过后才可“核对并发布”；发布前重新读取文件校验。版本与校验清单在保存草稿后锁定，无需手动输入版本。上传支持进度与取消，每文件最多 2 GiB，每个平台最多 8 个文件。同版本的两个平台各建一个草稿，并保持标题、说明一致；界面会沿用已发布平台的说明。大于 2 GiB 的包仍可使用 CLI（上限 20 GiB）。

描述文件最多 32 KiB，必须包含 `version` 和 `files[]` 中每个文件的 `url`、Base64 `sha512`；`size` 可选，提供时必须是正整数字节数。没有 `size` 时仍校验 SHA-512，并记录实际上传大小，公开更新接口始终包含大小。产品打包脚本会在 electron-builder 完成后复核哈希并补齐大小，官网兼容历史无大小文件。只接收当前支持平台的本地文件名，不访问 YAML 内的远程地址。只需上传更新 YAML，不需要 `builder-debug.yml`、`builder-effective-config.yaml` 或 `.blockmap`。网页只接受清单中列出的软件包，主更新包必需，清单中的其他软件包可选；未列入清单的 portable ZIP 等附件仍可通过 CLI 发布。旧草稿保留，须补充匹配版本和平台的描述文件，并核对已有文件后才能继续上传或发布；已发布版本仍可维护说明与上下架。原始描述文件内容保存在草稿 JSON 中，随草稿一起保留或移入回收目录。

此校验保证上传与发布的字节匹配打包清单，不代替数字签名或目标平台安装测试。CLI 保留原有本地发布流程，计算真实文件哈希，但不要求导入打包描述文件。详见 [ADR 0017](docs/adr/0017-manifest-first-release-upload.md)。

已发布版本可修改标题、更新说明、上下架状态；安装包不可覆盖。草稿及其文件可移至本地回收目录。发布瞬间参与当前自动更新策略，网页新版本默认立即发布、100% 灰度；更细的发布时间、最低版本与灰度策略继续使用 CLI/受控目录维护。

版本类型由 SemVer 自动识别，页面与发布确认显示正式版、Beta 测试版、RC 候选版或其他预览版。新版客户端的正式版频道只接收正式版；测试版频道同时接收正式版、`-beta` 和 `-rc` 首段的版本，排除 `-alpha`、`-dev` 等其他预览版。发布确认会列出新客户端的更新受众，并提示旧客户端只接收正式版；官网更新页仍允许手动下载全部已上架且已到发布时间的版本，首页默认下载只提供正式版。详见 [ADR 0024](docs/adr/0024-desktop-update-channels.md)。

先按 Desktop 文档在目标平台生成安装包。Windows 必须是 NSIS EXE（自动升级），可附 portable ZIP（手工下载）；macOS arm64 必须包含 ZIP（自动升级），可附 DMG（手工安装）。不支持同版本覆盖，应递增产品仓库的 `apps/desktop/package.json` 的版本重新构建。

也可以使用原有命令行流程：创建一份发布说明 JSON，例如 `content/release-notes.example.json`。从仓库根目录运行：

```sh
pnpm release --version 0.2.0 --platform windows-x64 --input /path/to/desktop-artifacts --notes content/release-notes.example.json --rollout 100
# 在 macOS 产物已传到本机的目录上登记另一个平台：
pnpm release --version 0.2.0 --platform macos-arm64 --input /path/to/desktop-mac-artifacts --notes content/release-notes.example.json --rollout 100
```

**CLI 的 `--input`、`--notes`、`--config` 相对路径基于本官网仓库根目录**；可使用绝对路径。`--config /path/to/website.json` 指定完整官网配置，优先于 `DSH_OPS_WEBSITE_CONFIG`；两者都未指定时使用 `config/website.json`。发布 CLI 不需要管理员密码。示例版本必须与真实产物版本一致，不会自动改写应用版本。文件名按完整版本和构建尾缀匹配：NSIS 为 `<product> Setup <version>.exe`，Windows portable ZIP 为 `<product>-<version>-portable-x64.zip`，macOS 为 `<product>-<version>-arm64.zip/.dmg`，保留对应 blockmap 命名；带 x64 尾缀的 EXE 也兼容。混合输入目录按完整版本和平台筛选，`0.3.0` 不会匹配 `0.3.0-beta.1`，`beta.1` 不会匹配 `beta.10`。发布工具自动计算大小和 SHA-512，不信任手填哈希；这不检查安装包内部的版本字段。

工具会取得独占发布锁、复制产物到临时目录、计算哈希、验证契约，先提交不可变的 `archive/<version>/<platform>/`，再原子替换 `catalog.json`。同版两个平台共享完全相同的标题与说明。失败不会宣告发布成功；进程崩溃后的 `.publish.lock` 和孤立归档需由发布人员确认没有其他发布进程后检查处理，不自动删除。禁止直接覆盖归档内的文件。

目录结构：

```text
.runtime/website-releases/
  catalog.json
  .admin-drafts/<uuid>/draft.json
  .admin-drafts/<uuid>/files/
  .trash/
  archive/0.2.0/windows-x64/WiseOperation Assistant Setup 0.2.0.exe
  archive/0.2.0/macos-arm64/WiseOperation Assistant-0.2.0-arm64.zip
```

`catalog.json` 使用 `@dsh-ops/release-contract` 的严格 schema。每版可配置 `enabled`、`rolloutPercentage`（0–100）、`minimumVersion`、`publishedAt`。策略变更应停止发布写入，校验整份目录后用同目录临时文件 + rename 替换；不要在服务读取时原地截断文件。目录损坏时 API 返回 503 并保留原文件。

灰度只控制应用内升级；官网展示所有已启用且到达发布时间的版本并允许手动下载。新版客户端按保存的 `stable` / `beta` 选择筛选，不再根据当前版本推断频道；关闭测试版后不会降级，已有 Beta / RC 用户等待更高正式版。同版、低版、未启用、不匹配平台、未达到最低版本和不在灰度分组的安装实例都不会获得更新。灰度按安装 UUID + 版本 + 平台稳定分组，频道不加入哈希，不记录设备、用户、会话或密钥。

## 管理接口

新增接口沿用管理员会话、Host/Origin 和 CSRF 校验，保存需携带当前 revision：

| 接口 | 用途 |
| --- | --- |
| GET/POST /api/admin/content-sync | 预览同步文件 / 校验 revision 后写回固定的 content 目录 |
| GET/PUT /api/admin/navigation | 分组、章节顺序与隐藏配置 |
| GET/POST /api/admin/images | 图片库及原始二进制上传（name 查询参数） |
| GET/HEAD /media/:sha256.:ext | 受控图片公开读取 |
| POST /api/admin/releases/manifest | 校验打包描述文件并预览版本、平台和文件清单（不创建草稿） |
| GET/POST /api/admin/releases | 发布清单 / 用描述文件和更新说明新建草稿 |
| PUT /api/admin/releases/drafts/:id/manifest | 为旧草稿补充描述文件并校验已有文件，需 revision |
| GET/PUT/DELETE /api/admin/releases/drafts/:id | 读取、更新、移除草稿 |
| POST/DELETE /api/admin/releases/drafts/:id/files?name=... | 上传、移除软件包；上传使用 X-Revision |
| POST /api/admin/releases/drafts/:id/publish | 确认发布草稿 |
| PUT /api/admin/releases/published/:version | 修改版本说明及上下架状态 |
| GET/POST /api/admin/knowledge | 知识库目录（含下架条目） / 新建条目 |
| PUT/DELETE /api/admin/knowledge/:id | 修改、删除知识库条目 |
| POST /api/admin/knowledge/skills?name=... | 上传技能文件；相同技能名替换原文件，上传使用 X-Revision |
| DELETE /api/admin/knowledge/skills/:name | 移除未被知识库引用的技能，需 revision |

二进制上传使用 `application/octet-stream`，总超时 30 分钟，空闲超时 60 秒。最多两个并行上传；JSON 仍限制大小并使用 15 秒接收超时。生产网关需要匹配请求大小、超时，并转发原始 Host。备份时保留 `contentDirectory` 和 `releaseDirectory`。详见 [ADR 0013](docs/adr/0013-website-admin-assets-and-releases.md)。

## 公开 API

```http
GET /api/releases/check?installationId=123e4567-e89b-42d3-a456-426614174000&currentVersion=0.2.0&platform=windows-x64&channel=stable
```

无更新：`{"schemaVersion":1,"updateAvailable":false}`。有更新返回 `version`、`platform`、固定版本的 `feedUrl`、`releaseNotesUrl`、`artifact: {name, size, sha512}`。协议由产品仓库的 `packages/shared/release-contract/src/index.ts` 维护，官网使用锁定的同包制品，见 [共享协议来源与更新](vendor/README.md)。

`channel` 可选且仅允许 `stable` / `beta`；未知、空值、重复参数均返回 `400 INVALID_UPDATE_QUERY`。新版客户端必须显式传入用户选择。缺席时统一按 `stable` 处理，无论当前安装正式版还是预览版，都只接收更高正式版；旧三参数请求继续有效。响应与固定版本 feed 形状仍为 schemaVersion 1，继续使用 `latest.yml` / `latest-mac.yml`，不新增 `beta.yml`。部署先升级官网再发布新版客户端；新客户端不得在失败后省略 `channel` 静默回退。

| 接口 | 用途 |
| --- | --- |
| GET /health | 服务存活检查 |
| GET /api/releases | 官网版本记录和下载列表 |
| GET /api/releases/check | Desktop 升级策略 |
| GET /updates/archive/:version/windows-x64/latest.yml | electron-updater NSIS 元数据 |
| GET /updates/archive/:version/macos-arm64/latest-mac.yml | electron-updater macOS 元数据 |
| GET /updates/archive/:version/:platform/:filename | 目录中登记的文件，支持 HEAD、单段 Range、ETag |
| GET /api/knowledge/metrics | 旧客户端 v1 当前配置投影，单公共技能与三个固定工作流 |
| GET /api/knowledge/metrics/skill | 原公共技能的当前文件，按持久身份定位 |
| GET /api/knowledge/metrics/v2 | 新客户端完整工作流映射与每库单技能引用 |
| GET /api/knowledge/metrics/v2/skills/:name/:sha256 | 指定名称与哈希的不可变技能文件 |
| GET /api/knowledge/metrics/skills/:name | 按技能名下载文件字节，ETag 为内容 SHA-256 |
| GET /api/experts/v1/catalog | 当前工号可见的云端专家目录与这些专家引用的自定义工具定义（工号放在 `X-Ops-Employee-Id` 请求头）；带 `X-Ops-Expert-Features: scenarios` 时另含专家常用场景与内置专家场景覆盖。ETag 按工号与特性区分 |
| GET /api/experts/v1/experts/:id/versions/:n/responsibility | 已发布版本的职责全文，不可见一律 404 |
| GET /api/experts/v1/experts/:id/versions/:n/skills/:name | 已发布版本的技能文件字节，带 `X-Skill-Sha256` |

安装包支持管理员网页上传发布与原有 CLI 发布，复用同一个发布事务。拒绝目录遍历、非法文件名、符号链接和目录外文件；下载流在连接断开时关闭。安装包可放在官网自己的持久化磁盘，目前不接第三方对象存储/CDN。

帮助文档另有只读 `/api/guide`（支持 `q` 全文搜索）、`/api/guide/:id`。`/api/admin/session` 和 `/api/admin/login` 提供登录，`/api/admin/guides`、`/api/admin/guides/:id` 及其 `history`、`restore`、`archive`、`export` 子路由需要管理员会话；写入同时检查 Origin、Host 和 CSRF，使用当前 revision 避免覆盖并发修改。

## 知识库元数据（指标知识库）

管理员在 `/admin` 的“知识库”页签集中维护指标知识库的元数据与技能文件，可上传多个技能，再为每个知识库选择引用一个技能（也可不引用）。检索工作流以“名称 / 值”逐行维护。官网只保存和分发元数据与技能文件，不连接 DataAgent、不保存租户凭据，也不执行技能内容。办公助手需要接入下述 v2 公开契约后才能消费各知识库引用的技能与自定义工作流；本仓库不包含产品端接入实现。

### 存储布局

```text
.runtime/website-content/knowledge/catalog.json        # v2 目录本体，schemaVersion + updatedAt + skills + items + legacy_skill_name
.runtime/website-content/knowledge/skills/<sha256>.zip # 按内容哈希落盘的技能文件，不可覆盖
.runtime/website-content/knowledge/skills/<sha256>.md
.runtime/website-content/knowledge/.trash/catalog-<时间戳>.json  # 覆盖或删除前的目录副本
```

写入使用 `knowledge/.knowledge-lock` 互斥锁与同目录临时文件 + rename。`revision` 是 `catalog.json` 规范化内容的 SHA-256，不写进文件本身；所有写接口必须携带当前 `revision`，不一致返回 `409 REVISION_CONFLICT`。条目上限 500，`id` 创建后不可修改，`tenant_id` 在目录内唯一；`id` 省略时由服务端生成 `metrics-` + 10 位十六进制。`catalog.skills` 最多保存 100 个名称唯一的技能，各条目的 `skill_name: string | null` 引用其中一个名称；同一个技能可以被多个知识库复用。替换同名技能保留引用，删除知识库不删除技能；替换或移除技能后旧文件仍按哈希保留在 `skills/`。

读取旧 `schemaVersion: 1` 目录时，顶层 `skill` 转换为 `skills` 数组，所有旧知识库自动以 `skill_name` 引用原公共技能；没有公共技能时为 `null`。`legacy_skill_name` 固定记录原公共技能身份，同名文件更新后新旧端都获取其当前版本。旧条目级 `skill` 继续忽略。读取不改写磁盘，首次成功写入前备份原目录，再原子保存 v2；升级前仍需完整备份整个 `knowledge/`，升级后重新读取 revision。

未发布中间版本的 `skill_names`：零项转为 `null`，一项转为该名称，多项完整保存在 `pending_skill_names` 并在管理页提示选择一个，明确保存前不公开该条目。缺失原公共技能身份时从有效 v1 备份恢复，找不到则在管理页明确选择一次，绝不使用技能数组首项；未确认时旧接口返回 `503 LEGACY_SKILL_UNRESOLVED`，新版接口仍可用。`PUT /api/admin/knowledge/compatibility` 携带 `legacy_skill_name` 和 `revision` 完成该一次性确认。

### 公开契约

`GET /api/knowledge/metrics/v2` 的 `items` 只返回 `enabled` 条目，`skills` 返回全部已上传技能，包括尚未引用的技能。响应头 `Cache-Control: no-store`、`ETag: "<revision>"`，`If-None-Match` 命中返回 304 空响应：

```json
{
  "schemaVersion": 2,
  "revision": "271715833d763c8e71f66c1af43188701972f1b119cf3d99f23a8c136747b494",
  "updatedAt": "2026-10-09T02:05:00.000Z",
  "skills": [
    { "name": "metric-skill", "file_name": "metric-skill.zip", "sha256": "1f78d1c949a2a8a65c935ee4a3a57675cd8a934502b888987023e96a0b005e4b", "size": 336, "kind": "zip", "uploaded_at": "2026-09-18T14:40:24.473Z" },
    { "name": "report-skill", "file_name": "report-skill.md", "sha256": "a21f6abc7cd83bb67fc8e55879e51685f60899a81abc4a95605dcf8abc38e9c2", "size": 128, "kind": "md", "uploaded_at": "2026-10-09T02:00:00.000Z" }
  ],
  "items": [
    {
      "id": "metrics-retail",
      "tenant_name": "示例零售",
      "tenant_id": "tenant-retail",
      "knowledge_retrieve_workflow_id": { "get_card_index": "wf-card-index", "get_card_meta": "wf-card-meta", "query_card_data": "wf-card-data", "weekly_summary": "wf-report-summary" },
      "skill_name": "metric-skill",
      "knowledge_id": { "card_index_knowledge_base": "kb-card-index", "card_meta_knowledge_base": "kb-card-meta" },
      "knowledge_base_meta": {
        "knowledge_description": "零售业务的核心指标口径与报表说明。",
        "indicators_cover": "1,200 项",
        "reports_cover": "32 张",
        "update_frequency": "每日 07:00",
        "typical_indicators": ["GMV", "动销率"]
      },
      "enabled": true,
      "created_at": "2026-09-18T14:40:24.371Z",
      "updated_at": "2026-10-09T02:05:00.000Z"
    }
  ]
}
```

外层字段名沿用 snake_case。`knowledge_retrieve_workflow_id` 是名称到工作流 ID 的映射，允许空对象，最多 50 项；新增或改名的 key 必须匹配 `^[A-Za-z0-9_-]{1,64}$`，拒绝 `run_code`、`__proto__`、`constructor`、`prototype`；value 最多 256 字符。名称和值去除首尾空白后不能为空，名称不能重复。历史已存名称仍可读取和原名保存，管理页提示无效方法名，不自动改名。客户端以 key 注册方法，以 value 调用工作流。

`skill_name` 只能为已上传技能的一个名称或 `null`。新建省略时使用 `null`，更新省略时保留引用，显式 `null` 解除引用。其余长度上限：`tenant_name` 80、`tenant_id` 128、各 knowledge ID 256、`knowledge_description` 2000、`indicators_cover` / `reports_cover` / `update_frequency` 各 80、`typical_indicators` 最多 50 项且每项 80。类型定义在 [`shared/knowledge.ts`](shared/knowledge.ts)。

原地址 `GET /api/knowledge/metrics` 始终返回 `schemaVersion: 1`，从同一份当前配置投影：只包含已上架、引用 `legacy_skill_name`（双方均无技能也允许）且三个固定工作流完整的知识库；新建且满足条件的库同样可见。每个条目移除单技能引用字段，仅保留 `get_card_index`、`get_card_meta`、`query_card_data` 并附同值 `quer_card_data` 别名；顶层 `skill` 为原公共技能的当前元数据。其他技能或自定义工作流库只供新版。迁移时旧拼写转为标准拼写，但两者同时存在且值不同时完整保留、管理页提示且不进入 v1；v2 不改写自定义 key。

两种响应各自按实际表示生成 revision/ETag，互不复用 304。旧响应最多 2 MiB、新响应最多 96 MiB；写入前校验旧投影大小，超限返回 `KNOWLEDGE_CATALOG_TOO_LARGE` 且不改权威目录，不能截断旧库。修改名称、描述或原工作流 value 后两端看到同一份最新配置；下架或删除从两份公开目录移除，已绑定客户端仍遵循其原同步流程。

`GET /api/knowledge/metrics/skill` 按 `legacy_skill_name` 下载当前公共技能，增加技能不影响该路径。按名称下载 `/api/knowledge/metrics/skills/:name` 继续可用。二者为 `no-store` + 内容哈希 ETag。新客户端使用 `/api/knowledge/metrics/v2/skills/:name/:sha256`，文件内容与名称双重校验，使用 `public, max-age=31536000, immutable`，同名替换后旧哈希仍可下载。所有下载带 `X-Skill-Name` 和 `X-Skill-Sha256`，未知名称或版本返回 404。旧无哈希地址保留既有跨请求上传竞态，客户端应继续校验并刷新重试，不为此冻结当前配置。

旧单数上传 `POST /api/admin/knowledge/skill` 保留为上传别名。移除技能仍执行引用检查，原公共技能身份也视为占用，不能删除；需更新时同名上传即可。

### 管理流程与技能文件规则

新建或编辑条目后保存即生效，无需发布步骤；“上架”开关控制是否出现在公开目录。先在技能区上传所需文件，再在每个知识库内选择引用并保存。上传不同技能名会增加技能；相同 frontmatter 名称会替换原技能文件并保留所有引用。移除技能前须先取消所有知识库（包括下架条目）对它的引用并逐一保存，否则返回 `409 SKILL_IN_USE`。技能文件按 `application/octet-stream` 上传，`name` 查询参数给出原始文件名，`X-Revision` 携带当前 revision。服务端只做字节级校验，不解压到磁盘、不执行任何内容：

- 大小 ≤ 5 MiB，扩展名 `.zip` 或 `.md`；超限返回 `413 UPLOAD_TOO_LARGE`，非二进制请求返回 `415 BINARY_REQUIRED`。
- `.md` 文件本身即 `SKILL.md`。
- `.zip` 只读取中央目录，仅支持 stored 与 deflate；拒绝 zip64、加密、多卷、数据描述符缺少长度、重复条目名、绝对路径、`..`、反斜杠、符号链接位，以及超过 256 个条目或解压后超过 20 MiB。解压前按中央目录声明的长度限流，解压后核对长度与 CRC-32。
- 压缩包中必须恰好有一个 `SKILL.md`，位于根目录或唯一的一级目录内；位于目录中时目录名必须等于 frontmatter 的 `name`。
- `SKILL.md` 的 frontmatter 为 `---` 包裹的 YAML（拒绝重复键与别名），必须含小写连字符格式的 `name`（≤ 64）与非空 `description`（≤ 500）。`name` 写入 `catalog.skills[].name`，是知识库引用和替换技能的稳定标识；上传文件名不是这个标识。
- 校验通过后按内容 SHA-256 落盘为 `skills/<sha256>.<zip|md>`；已存在同哈希文件时直接复用，不重写。

错误码：`INVALID_KNOWLEDGE` 400、`KNOWLEDGE_NOT_FOUND` 404、`KNOWLEDGE_ID_TAKEN` 409、`TENANT_ID_TAKEN` 409、`KNOWLEDGE_LIMIT` 409、`INVALID_SKILL_FILE` 400、`INVALID_SKILL_REFERENCE` 400、`SKILL_NOT_FOUND` 404、`SKILL_IN_USE` 409、`KNOWLEDGE_SKILL_LIMIT` 409、`SKILL_SELECTION_REQUIRED` 400、`INVALID_WORKFLOW_NAME` 400、`LEGACY_SKILL_UNRESOLVED` 503、`LEGACY_SKILL_ALREADY_CONFIGURED` 409、`KNOWLEDGE_CATALOG_TOO_LARGE` 503、`REVISION_CONFLICT` 409。详见 [ADR 0018](docs/adr/0018-metric-knowledge-catalog.md) 与[知识库维护流程](docs/runbooks/website-guide-maintenance.md#知识库与技能维护)。

## 专家分发（云端专家）

管理员在 `/admin` 的“专家分发”页签导入创建者从工作助手导出的专家包（`*.expert.zip`），或直接新建、编辑专家；设置可见范围后发布，
可见范围内同事的工作助手在下次同步时收到（打开专家页即同步）。设计与取舍见 [ADR 0022](docs/adr/0022-expert-distribution.md)，
产品侧见产品仓库 ADR 0026；日常操作、备份与排查见 [专家分发运维](docs/runbooks/expert-distribution.md)。常用场景与内置专家场景见
[ADR 0023](docs/adr/0023-expert-scenarios.md)。

- **存储**：`<contentDirectory>/experts/` 下的 `catalog.json`、不可覆盖的 `versions/<专家 ID>/<版本>.json`、按内容哈希保存的
  `skills/`、待确认的 `imports/`（24 小时后清理）与 `.trash/`。备份内容目录即可完整恢复。
- **导入**：上传后先出预览（目标、变化、警告与错误），确认后写入草稿，可选“导入并发布”。同一来源（导出人工号 + 本机专家 ID）
  再次导入时自动选中原专家。专家包上限 1 GB、64 个条目；每位专家最多 30 个技能，单个技能压缩后不超过 200 MB。
  技能按契约 `./skill-tree` 的共用规则检查（与工作助手「我的技能」导入一致：2000 个文件、解压后 200 MB、32 层、文件名 120 字、
  路径 180 字；子文件夹里的 `SKILL.md` 是普通文件；系统生成的 `__MACOSX` 等不算内容；描述不限字数），不符合时逐条写明规则与上限；
  超出旧版工作助手能力的技能或专家在预览里给出警告（不阻止导入）。手动上传技能用同一套规则。
- **可见范围**：上架 / 下架、全员或指定工号（最多 2000 个，不区分大小写），保存即生效；负责人始终可见；新建专家默认未上架、只有负责人可见。
- **自定义工具库**：`experts/tools.json`，“自定义工具”页签管理（`GET /api/admin/expert-tools`、`PUT` / `DELETE /api/admin/expert-tools/:key`）。
  导入时按服务名复用或新增，同名不同配置由管理员选择“更新已有工具”或“改名后新增”；保存即对所有引用它的专家生效；
  被专家引用的工具不能删除。只保存凭据项的名称与获取说明，令牌由每位使用者首次使用时在自己电脑上填写。
- **常用场景**：云端专家的 `scenarios`（最多 8 个，名称、简介、带 `【】` 的提问模板、可选工作模式与图标）跟随专家版本发布；保存即按契约规则校验。
  公开目录只对请求头 `X-Ops-Expert-Features: scenarios` 返回场景，有场景的专家其 `starterPrompts` 一律为场景名称；响应 `Vary` 含这个请求头。
- **内置专家场景**：`experts/builtin-scenarios.json`，“内置专家场景”页签管理（`GET /api/admin/expert-builtin-scenarios`、
  `PUT` / `DELETE /api/admin/expert-builtin-scenarios/:expertId`、`POST .../:expertId/publish`）。已发布的覆盖整体替换该内置专家随产品发布的场景
  （空列表即隐藏），以目录信封的 `builtinScenarios` 下发给所有读取场景的客户端；恢复为随产品发布即撤下。
- **安全**：公开接口只读，拒绝浏览器来源（403）、按来源限流、工号不写普通日志；专家包与目录中不含任何令牌、Authorization 头或知识库正文。
  官网不下发专家组合文件，端侧只按声明开关五组基础能力。
- **契约**：结构来自产品仓库的 `@dsh-ops/expert-distribution-contract`，以 vendor 制品锁定版本（来源见
  `vendor/expert-distribution-contract.json`）；契约变更时按 `vendor/README.md` 重新打包并更新锁文件。

错误码：`INVALID_EXPERT_PACKAGE` 400、`EXPERT_PACKAGE_REJECTED` 400、`IMPORT_NOT_FOUND` 404、`EXPERT_NOT_FOUND` 404、
`EXPERT_SKILL_NOT_FOUND` 404、`NOTHING_TO_PUBLISH` 409、`INVALID_EMPLOYEE_ID` 400、`BROWSER_REJECTED` 403、`REVISION_CONFLICT` 409、
`INVALID_EXPERT_TOOL` 400、`EXPERT_TOOL_NOT_FOUND` 404、`EXPERT_TOOL_IN_USE` 409、`INVALID_SCENARIOS` 400、`BUILTIN_EXPERT_NOT_FOUND` 404。

## 验证与依赖

```sh
pnpm check
pnpm build
```

运行时依赖：Vue 3.5.42（vuejs/core，MIT）、yaml 2.9.0（eemeli/yaml，ISC）、Vditor 4.0.0（Vanessa219/vditor，MIT）、markdown-it 15.0.2（markdown-it，MIT）、由产品仓库维护的 release-contract 0.1.3 制品。构建依赖：Vite 7.3.6 / @vitejs/plugin-vue 6.0.8（vitejs，MIT）、vue-tsc 3.3.11（vuejs/language-tools，MIT）、TypeScript 5.9.2（Microsoft，Apache-2.0）、tsx 4.23.12（privatenumber，MIT）。来源均为 npm；精确版本与完整传递依赖由 pnpm-lock.yaml 管理。Vite/esbuild 为开发构建依赖，不进入 Desktop 运行时。

Windows x64 上的真实 Desktop 更新烟测由产品仓库执行：先在官网运行 `pnpm build`，再在产品仓库设置 `DSH_OPS_WEBSITE_PROJECT` 为官网的绝对路径并运行 `pnpm desktop:smoke:updates`。这只用于跨仓库集成验收，日常运行不需要该变量。

GitHub 的 `Website checks` workflow 自动执行冻结安装、类型检查、测试及构建；跨仓库真实更新验收在产品仓库的 `Desktop and website update integration` 手动 workflow 中固定官网完整提交 SHA 后执行。

## 运营统计

管理员 `/admin` 新增“运营统计”，支持登录人数、DAU/近30天MAU、用户明细与排名、功能使用和操作明细。独立 SQLite 与采集 API 不改变普通 logger。本地 `pnpm dev` 开放免认证采集，产品开发 overlay 默认上传至 `http://127.0.0.1:4173`，无需 Token 环境变量。未取得 WeLink 工号时保持匿名。部署时显式配置 `trackingEnabled: true`，正常 `pnpm start` 即可接收远程 Host 的 production/development/test 批次；采集认证后续实现，管理员登录保持原规则。详见 [运营统计部署](docs/runbooks/operational-tracking.md) 和 [ADR 0019](docs/adr/0019-operational-tracking.md)。

运营统计环境：管理员页面通过 `/api/admin/analytics/context` 获取默认环境。`pnpm dev`（--dev）默认开发，`pnpm start` 默认生产；采集开关只由 trackingEnabled 控制；手动选择保留为当前浏览器 UI 偏好。数据均按所选环境查询，空表先核对环境、日期与版本筛选。匿名对话、Token、Skill 可查看次数；登录用户数、DAU/MAU 和排名直接按终端当前 WeLink 工号归属。

运营统计支持“全部环境”，跨环境、跨平台的同一工号统一去重；页面不再提供平台筛选。没有工号的旧事件保留匿名，不补归当前登录者。
