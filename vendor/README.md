# 共享发布协议制品

`dsh-ops-release-contract-0.1.3.tgz` 是产品仓库 `packages/shared/release-contract` 的原始 pnpm pack 产物，统一官网与 Desktop 的显式 HTTP/HTTPS 源地址和正式版 / Beta / RC 更新规则。请求可带 `channel=stable|beta`，响应与 catalog 仍为 schemaVersion 1；缺参数统一按 stable 处理（仅接收更高正式版），新版测试版频道只接收正式版及首段精确为 beta / rc 的预发布。来源提交、输入哈希与制品 SHA-256 记录在 [release-contract.json](release-contract.json)。源包由产品仓库维护；官网不直接修改制品内的校验器。旧 0.1.0、0.1.1、0.1.2 制品保留用于审计，不再被当前依赖引用。

当前 0.1.3 制品的输入已逐文件核对，与来源清单中 `sourceCommit` 对应的已提交源码一致（`sourceWorkingTree: false`）。

未提交源码的本地联调制品以 `sourceWorkingTree: true` 明确标记，`sourceCommit` 记录基线，`sourceSha256` 固定实际输入；不将基线提交冒充已包含改动的发布提交。正式发布应从审核后的对应源码重新构建并核对输入哈希。

本仓库随源码保存此包，安装不需要相邻 checkout、私有 registry 凭据或联网拉取 Git 仓库。pnpm-lock.yaml 校验 tarball 完整性；第三方依赖仍按锁文件从 npm 安装。没有新增第三方协议实现、原生依赖或许可证授权。

升级时先在产品仓库修改源包、递增精确版本、运行契约与 Desktop 更新测试并提交审核后的源码。在该仓库执行：

```sh
pnpm --filter @dsh-ops/release-contract build
pnpm --dir packages/shared/release-contract pack --pack-destination /path/to/ops-harness-website/vendor
```

随后在官网更新 package.json 中的制品路径、此来源清单和锁文件，执行 `pnpm install`、`pnpm check`、`pnpm build`。确认旧客户端兼容性后在 Windows x64 完成跨仓库更新烟测。不得覆盖同版本制品或单独维护另一份协议源码。协议源码的 Git 历史保留在产品仓库，后续可以改用受控 registry 分发相同包。

## 专家分发契约

`dsh-ops-expert-distribution-contract-<版本>-<sha256前12位>.tgz` 来自产品仓库 `packages/shared/expert-distribution-contract`
的 pnpm pack：专家包、云端目录、可见性规则、自定义工具可移植定义与常用场景规则（0.1.1 起，含不依赖 zod 的 `/scenarios` 子入口），
官网与工作助手共用同一份结构和校验。当前为 0.2.5（补齐 `multimedia` 多媒体创作，覆盖当前产品实际装配的全部九项内置工具；包含 `dataops-tool`，显示名沿用 DataAgent连接器 / DataOps连接器；单个技能的共用规则 `./skill-tree` 与放宽的分发上限：30 个技能、单个 200 MB、整包 1 GB；
0.2.1 起 `.git`、`node_modules`、`.venv` 等依赖与版本库目录、IDE 配置、Python 缓存与 Office 临时文件，0.2.2 起 `package-lock.json` 等依赖锁文件不算技能内容、不计数），
输入与产品仓库提交 abedc43c（分支 codex/dataops-expert-contract）的源码逐文件一致；该提交基于官网原用的 ca33fb8，仅补 DataOps、多媒体创作清单、官网连接器中文显示名与回归测试，客户端工具描述与实现保持原样，不包含后续 MCP 子工具配置扩展。0.2.2、0.2.3、0.2.4 制品保留用于审计，不再被当前依赖引用。来源提交、输入哈希与
制品 SHA-256 见 [expert-distribution-contract.json](expert-distribution-contract.json)，`test/standalone.test.ts` 核对制品、
安装包与契约版本。更新时在产品仓库完成契约 build/test 后 pack 到 vendor，以内容哈希命名新制品，更新 package.json、来源清单
与锁文件，再执行官网 `pnpm install --no-frozen-lockfile` 与 check/build。

## 运营打点协议

`dsh-ops-tracking-contract-0.1.0-f76676da1bb6.tgz` 来自产品仓库 `packages/shared/tracking-contract` 的 pnpm pack。它只依赖精确版本 zod，官网从 `@dsh-ops/tracking-contract` 根入口读取事件契约，不安装或加载 DSH、Cordis、Host 插件及其私有依赖。契约目录版本 4，事件/批次 schemaVersion 仍为 1，支持 WeLink 姓名、部门及资料查询时间。产品原 `@dsh-ops/tracking/contracts` 仅转导出此唯一契约源码以保持兼容。

来源、工作区输入及 SHA-256 见 [tracking.json](tracking.json)。按产品升级计划 K16，契约变更时必须构建纯包，不得再打包包含私有 workspace 依赖的完整 tracking 插件。更新时在产品仓库完成纯包 build/test 后 pack 到 vendor，以内容哈希命名新制品，更新 package.json、来源清单与锁文件，执行官网 `pnpm install --no-frozen-lockfile` 和 check/build。先重启官网，再更新终端；旧服务端严格校验会拒收新增字段。

当前为明确标记的 sourceWorkingTree 联调制品，正式发布应从审核后的源码重新生成。旧 `dsh-ops-tracking-*` 制品仅保留审计，不再被依赖引用；不得覆盖已有制品路径。
