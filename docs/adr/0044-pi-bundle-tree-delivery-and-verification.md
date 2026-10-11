# ADR-0044：Pi Resource Bundle 目录化交付与树校验（协议 v2）

- 状态：Superseded by ADR-0048（2026-10-11：Client 不再交付 Pi Bundle 目录树）
- 日期：2026-10-10
- 决策者：项目维护者
- 实施状态：待实施；Accepted 表示决策已批准，不表示协议已升级。
- 关联：[ADR-0030](./0030-pi-resource-bundle-and-tool-policy.md)、[ADR-0036](./0036-pi-sdk-single-file-and-shell-capability.md)、[ADR-0042](./0042-standard-pi-community-extensions.md)、[ADR-0043](./0043-project-local-pi-resources-unconditional-trust.md)

## 背景

ADR-0042 确定"标准社区扩展随 Client Release 统一交付"，其可行前提是每个扩展都能打成**自包含 ESM 单文件**，且 manifest 只对**入口文件**校验 sha256。`bundle-apps.ts` 的产物导入面自检强制这一点：除宿主虚拟模块外不允许残留未打包说明符。

该前提挡住了一类真实需求。实测 `pi-mcp-adapter@5.2.0`：

- 入口是 `index.ts`（TS 源码），声明 15 个真实依赖且不在包内 bundle；
- 含原生模块 `@napi-rs/keyring`、WASM `quickjs-wasi`、独立 helper 进程 `mcp-keyring-helper.cjs`；
- 裁剪掉宿主虚拟模块与不适用平台原生后仍有 81MB / 2376 文件。

esbuild 无法内联原生与 WASM，现有自检会正确地让构建失败。因此"要么放弃这类扩展，要么升级 Bundle 交付模型"。

同时，仅校验入口文件 sha256 的模型本身也不足以承载真实目录：若允许旁路文件存在，就存在"入口受校验、旁边文件被替换"的空隙。

## 决策

### 1. 资源条目升级为"单文件 / 目录树"判别联合

manifest 每个资源条目二选一，以是否含 `entry` 判别：

```ts
type PiBundleResource =
  | { id; kind; version; path; sha256 }                        // 单文件（现有形态，继续支持）
  | { id; kind; version; path; entry; treeSha256; fileCount }   // 目录树（新）
```

已有单文件资源不必改写；parser 必须拒绝字段混用（例如同时出现 `sha256` 与 `treeSha256`），不做宽松推断。

### 2. 树摘要必须确定性，且覆盖目录全部内容

对目录内所有常规文件：取 `/` 分隔的相对路径，按字节序排序；每个文件算 `sha256(relpath + "\0" + mode + "\0" + content)`（小写十六进制）；把这些结果按序拼接后再取一次 sha256，即 `treeSha256`。

规则：

- **不跟随符号链接**——目录内出现符号链接即判定失败，不做"解析后仍在目录内"的宽松判定；
- 忽略空目录；`mode` 至少反映 POSIX 可执行位；
- 路径沿用现有约束：相对路径、正斜杠、拒绝 `..` 与绝对路径；
- Client 枚举目录重算摘要，并核对 `fileCount`。**多余文件、缺失文件、内容改动、权限改动全部 fail closed**——比逐文件白名单更强，因为它同时覆盖"多出来的文件"。

### 3. 协议版本升到 2，旧 Client 明确拒绝

`PI_BUNDLE_PROTOCOL_VERSION` 由 1 升到 2。旧 Client 的严格 parser 按既有语义拒绝未知版本：不加载任何资源、不上报 Bundle 能力。遵守既有 Server-first 更新规则，不提供降级或部分加载路径。

失败语义不变：任何校验失败都表现为"无可用 Bundle"。

### 4. 构建期强制剔除宿主运行时并按平台裁剪

- 树内**不得**包含宿主虚拟模块（`PI_EXTENSION_HOST_MODULES`：`@earendil-works/pi-*`、`typebox`、`@sinclair/typebox`、`@mariozechner/pi-*`）。宿主在单文件发布形态下把这些说明符映射到内存模块；打入第二份会形成重复 registry 与重复类，且与宿主不是同一实例。
- 不适用平台的 native 构件按发布 variant 互相裁剪（沿用 `packages/client` 现有 `VARIANT_EXCLUDES` 思路）。
- 构建期自检：无宿主模块、无逃逸符号链接、`fileCount` 与实际一致、摘要可复算。

### 5. 接受并文档化新增代价

- **体积**：托管 `pi-mcp-adapter` 后预计每次 Release 增加约 81MB（裁剪后）。
- **第三方扩展可在 VCPDeck 数据根内落盘**：实测该扩展自建 `SettingsManager` 并 `flush()`，首次 session 会写 `<agentDir>/settings.json`，绕过宿主注入的 in-memory settings。位置在 VCPDeck 数据根内（**不是**原生 `~/.pi`），且因宿主始终使用 in-memory settings 而**功能上无效**。接受，但零污染门禁须确认污染范围仅限 VCPDeck 数据根。
- **平台依赖**：OAuth 凭据依赖 OS keychain，在 SYSTEM 类服务账户下可能不可用；非 OAuth 的 stdio / bearer HTTP 服务器不受影响。
- **网页能力面**：扩展自带终端组件（panel/overlay/keybinding/native window）在 rpc 模式下不可用，沿用 ADR-0040 边界。

## 候选方案

1. **维持单文件自包含，放弃这类扩展**：边界最干净，但等于把带原生/WASM 的扩展整体排除在复用范围外；不采用。
2. **允许旁路依赖树，但仍只校验入口文件**：会留下"入口受校验、邻近文件可替换"的空隙；不采用。
3. **把依赖打进单文件并特例外部化原生模块**：原生模块仍需真实存在于磁盘且不受摘要覆盖，等于把方案 2 的空隙挪到原生文件上；不采用。
4. **对树逐文件列白名单（manifest 列全部文件）**：manifest 体积随文件数线性增长（本例 2376 项），且新增文件需要显式列举才被发现；树摘要更小且更严格；不采用。

## 后果

正面：带原生/WASM/helper 进程的标准扩展可以随 Release 交付，复用面显著扩大；树校验覆盖目录全部内容，比入口摘要更严格；单文件资源与树资源共存，历史 Bundle 不必改写。

负面与风险：Release 体积与安装耗时上升（本例约 +81MB）；Client 校验需要枚举目录并逐文件哈希，激活 Bundle 的成本高于单文件；协议 v2 使旧 Client Pi 不可用，必须 Server-first 发布；`fileCount` 与摘要的计算必须严格确定性，否则不同平台/文件系统会产生假失败（需以真实发布布局验收，不能只靠单元测试）。

## 验证与退出条件

- 树形态资源在真实发布布局下通过 Client 校验并被真实 SDK 加载（独立 node 子进程，非 tsx）。
- 篡改树内任一非入口文件、增删文件、修改权限、植入符号链接，全部 fail closed。
- 单文件形态资源继续工作；parser 拒绝字段混用；v1 manifest 在 v2 Client 下被明确拒绝。
- 构建产物树内不含宿主虚拟模块；win-x64 与 linux-x64 的平台裁剪互斥正确。
- native Pi 零污染门禁继续全绿，且污染范围审计确认仅限 VCPDeck 数据根。
- 体积与文件数实测记录，Release 归档与 Client 更新仍可用。

若依赖布局再次变化（例如扩展要求运行期从网络拉取依赖、或需要跨平台单包携带全部原生构件），应重新评估本决策，不静默放宽摘要覆盖范围。
