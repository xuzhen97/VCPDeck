# ADR-0063：发布构件采用内容寻址与逐文件完整性清单

- 状态：Proposed
- 日期：2026-11-11
- 决策者：项目维护者
- 关联：[ADR-0006](./0006-file-control-and-data-plane-separation.md)（数据面边界）、[ADR-0012](./0012-bundled-release-artifacts.md)（构件格式与打包管线，本 ADR 扩展其第 4、4.1 节）、[ADR-0019](./0019-direct-release-upload-to-external-storage.md)（直传数据面，本 ADR 扩展其整包完整性契约）、[ADR-0022](./0022-release-artifact-and-launcher-retention.md)（归档与 Launcher 分层清理）、[ADR-0051](./0051-release-client-catch-up-retry.md)（补更重试）、`docs/design/release-and-update.md`、`docs/compatibility.md`

## 背景

当前发布由 ADR-0012 与 ADR-0019 定为「整包 zip + 整包 SHA-256 单一契约」：打包管线把 `server/` 与 `client/` 装入同一 zip，`manifest.json` 六键不含逐文件哈希，整包 SHA-256 由 Server 写入 `Release.archives`；Launcher 的 `prepare` 是「下载完整 zip → 整包校验 → 解压」，上传与下载数据面直连且 Server 不读正文。

ADR-0012 曾把构件一次性从 513 MB 瘦到约 150 MB，但没有解决逐版本重传。实测 0.19.0 → 0.19.1 业务代码只差 89 字节，整包仍重传 99,569,197 bytes；0.19.4 的 win-x64 为 99,569,647 bytes、linux-x64 为 113,913,573 bytes，10,721 条目、展开约 302 MiB，其中 `server/` 73.19 MiB、`client/` 19.68 MiB，真正随版本变化的是 `server/dist/main.js`（压缩后 2.38 MiB）。ADR-0051 亦明确「单次补更重试会产生一次完整构件下载」。上传双平台 ×2、下载 1 台 Server + N 台 Client，带宽与耗时随机器数线性放大。

另有两笔既有欠账：`docs/design/release-and-update.md:365` 无 archive 条目路径穿越预检、`:451` 缺构件发布者数字签名；`launcherMinVersion` 恒为 `"0.0.0"` 且未执行校验。

本决策改动 archive/manifest 公共契约、Server–Launcher 控制协议、持久化模型（Prisma migration）与信任边界（签名密钥），命中 `docs/adr/README.md:50-57` 的多条「必须写 ADR」；ADR-0006:71 亦点名「内容寻址/去重、更强供应链完整性要求」应创建新 ADR 重新评估数据面与校验模型。按 `docs/adr/README.md:5`，不修改 ADR-0012/0019 的 Accepted 结论与状态，本 ADR 只声明扩展范围。

## 决策

1. **过渡期双格式并存，不建两套管线**。full zip 字节级保持旧格式（`manifest.json` 六键、整包 SHA-256、目录结构不变），额外附带 `manifest.json.sig` 条目；同一打包管线再产 ≤3 个 `vcpdeck-<version>-<platform>-delta-<fromVersion>.zip`，基线集合固定为最近 3 个成功版本（与 ADR-0022 / `RELEASE_CLEANUP_POLICY` 的 3 成功 + 30 天保底对齐）。旧格式 full 即过渡期要保留的那一份，供旧 Launcher／新装机／回退／组装失败兜底；delta 内容来自当前 staging，基线只需历史版本清单，无需历史构件或额外状态文件；跨度超窗口 → 无可用 delta，降级 full。

2. **追加可选清单契约**。full 的 `manifest.json` 与 `delta.json` 追加可选 `protocolVersion`、`kind`、`fromVersion` 与 `files: Array<{path, sha256, size, mode}>`（目标版本**完整**清单，非仅变化文件）。整包 `sha256` 语义不变、仍留空并由 Server 写入 `Release.archives`（`pack-release.ts:16-18` 的自指限制不变）。清单是组装与校验的唯一依据，不在清单中的条目（如 `.sig`）不得写入目标目录；`sha256` 的 64 位小写 hex 格式与未知字段按 `packages/shared/src/update.ts:141-176` 严格 parser 范式校验，不宽松猜测。

3. **安全双轨，同一变更落地**。Ed25519 对清单的规范化字节（固定键序、UTF-8、无尾随空白）签名，产物 `<清单>.sig`；Launcher 内置固定信任公钥（编译期常量 + 可选环境变量覆盖以便轮换演练），`prepare` 最先验签；采用**新增独立签名密钥**并定义独立轮换（先发布带新公钥的 Launcher，再切换签名密钥）。解压前对包内全部条目做路径预检（`..`、绝对路径、盘符、空字节、符号链接/硬链接条目、目标须落在 `apps/<version>/` 内），覆盖 full 与 delta 两条路径。旧格式仍走「可信操作者 + 整包 SHA-256」，新格式走「签名清单 + 逐文件 hash + 整包 SHA-256」；双轨在同一次变更中补齐 `docs/design/release-and-update.md:365`／`:451` 欠账。

4. **Launcher 用本地硬链接组装，控制协议零改动**。`UpdaterDeps` 的 `downloadZip/verifySha256/extractZip` 三件套全部复用；`/prepare` 入参仅追加可选 `candidates: Array<{fromVersion, url, sha256, size}>`，新 Launcher 按本地 `apps/` 中存在的基线目录自择一个、都不存在则降级 full（用原 `url`）。按清单把包内文件写入并逐项校验 `sha256`/`size`、Linux 按 `mode` 显式 `chmod(0o755)`，未变文件从基线目录 `fs.linkSync` 硬链接并校验 hash；任一失败删半成品目录 → 降级 full（仅一次）。**不建全局块缓存、不加引用计数/GC 状态文件**：历史版本目录即块池，VersionRetention 照常清理，被共享文件由硬链接自动留存。`Updater.apply` 的 `stop→switchTo→start→probe→回退` 时序不动。必须补齐「prepare 后台失败目前只有日志、`/prepare` 早已返回 200」的失败回传语义，否则 Server 会误派 apply。

5. **Server 数据面边界不变**。沿用 ADR-0019「Server 不读直传正文、不独立复核内容哈希」；上传会话契约主体 `{version, platform, sha256, size}` 与分片直传不变，仅增加 `artifactKind`（`full`｜`delta`）与 `fromVersion`（`String @default("")` 归一，full 固定 `""`），唯一键由 `@@unique([version, platform])` 改为 `@@unique([version, platform, artifactKind, fromVersion])`——此为 Prisma migration 与数据权威变化。`Release.archives` 的整包语义不变，仅在平台 JSON 内追加 `deltas[]` 与 `protocolVersion`。发布触发判据用**扩展 `hasAllReleaseArchives`**（双平台 full 齐备且该版本声明的全部 delta 齐备）而非新增显式 publish 步骤。Server **不判断 Client 当前业务版本**，由 `UpdateRequest` 附带可选 `candidates` 交 Launcher 自择。

6. **协议版本与端点**。新增 `GET /api/releases/:version/update?platform=&launcher=` 返回 JSON 更新计划 `{url, sha256, size, candidates?}`，只返回计划、绝不 302；`launcher` 必须为 `x.y.z` 且 major ≥ `CONTROL_PROTOCOL_VERSION`，archive 内可选的 `launcherMinVersion` 再做逐段比较（打包侧当前统一写 `0.0.0`，该比较为后续按版本收紧预留），不满足一律返回 `LAUNCHER_UPGRADE_REQUIRED`，绝不 302 给旧 Launcher 误执行。**增量包下载复用旧 `GET /api/releases/:version/file` 的可选 `fromVersion=x.y.z` 参数**（计划里的 `candidates[].url` 即指回该入口，Server 随 `UpdateRequest` 下发的 `candidates` 同理）：同一入口按基线定位 `deltas[]` 中的构件，direct 后端用 delta 自己的对象 key 换取直链、Local 后端直出 `vcpdeck-<version>-<platform>-delta-<fromVersion>.zip`；不带 `fromVersion` 时该端点行为逐字不变，旧 Launcher 继续只打它。实施时不另开 delta 字节端点（原稿设想），是为避免复制 ADR-0019 已定的 302 直链、短 TTL 缓存与错误码分流三套逻辑；代价是 `/file` 多一个可选参数，必须守住「缺省即旧行为」。本期一并实现 `launcherMinVersion` 强制校验并引入 `CONTROL_PROTOCOL_VERSION`，避免两次破坏性变更；协议字段与新增稳定错误码（`LAUNCHER_UPGRADE_REQUIRED`／`MANIFEST_SIGNATURE_INVALID`／`MANIFEST_PATH_UNSAFE`／`FILE_HASH_MISMATCH`／`DELTA_BASELINE_UNAVAILABLE`／`ASSEMBLE_FAILED`／`RELEASE_ARTIFACTS_INCOMPLETE`）统一落 `packages/shared/src/update.ts`，按 AGENTS.md:15 同步 Shared/Server/Client/SDK/Frontend/CLI 与测试。

7. **不做的部分**。本期不优化发版上传侧（CLI 仍上传 1 次 full zip ~100 MiB）、不拆 server/client 独立包、不裁 Prisma Studio 传递依赖、不建全局 `ContentBlock`／refCount／块级上传会话、不建立长期 Launcher 自动升级状态机。顺手修 `VARIANT_EXCLUDES` 跨平台裁剪 bug（白名单式排除改为按平台族统一排除）。

## 候选方案

| 方案 | 结论 |
| --- | --- |
| A 零风险止血（补裁剪、去 `.pdb`、拆 server/client 包） | 不单独采用，仅吸收 `VARIANT_EXCLUDES` 修复。拆包会同时改 manifest／`Release.archives`／Launcher，且与增量属同一需求的两条并行通道 |
| **B 内容寻址增量（delta 包 + 硬链接复用）** | **采用**。单包上传契约不变、控制协议零改动、无全局块表/引用计数，改动面最小 |
| C 二进制差分（bsdiff／`zstd --patch-from`） | 不采用：多机跨版本补更与回退要退全量，基线被 ADR-0022 清理即失效 |
| D 业务包与运行基座分层 | 不采用：等于重构发布子系统，属远期 |
| 阶段二：全局块去重索引（`ContentBlock` + refCount + 块级会话） | 本期不做：需重评 ADR-0006:71 的数据面边界，上传侧才随之增量 |

## 后果

**正面**：相邻版本更新单台只传变化文件（预计 < 5 MiB），Server 自更新与 N 台 Client 全部受益；补齐路径预检与发布者签名两笔欠账；不改上传侧数据面，ADR-0019 的边界保持；旧 Launcher 继续只打 `/file`，不带 `fromVersion` 时该端点行为逐字不变。

**负面与成本**：产物从 2 个 zip 增到 2 ×（1 full + ≤3 delta + 各自 sig）；`scripts/build/` 当前零测试，必须新增单测；新增独立签名密钥的保管、轮换与公钥分发责任；一次 Prisma migration；Server 需维护 `deltas[]` 索引与齐备判据；打包需读取历史版本清单求差集。

**风险与约束**：

- `files[]` 清单扩大攻击面，签名与路径预检必须同一变更落地；Token/Cookie/签名 URL/完整 archive 内容/preStart 输出仍不得进普通日志。
- 硬链接块池依赖本地历史版本目录，基线被 VersionRetention 清理时 Launcher 自动降级 full，Server 不因此调整归档生命周期。ADR-0022 的 available→deleting→cleaned 只删 Provider 对象与归档记录，与 Launcher 本地 `apps/<version>/` 分属两层、互不干涉；本 ADR 不要求引用计数。
- `fromVersion` 参与唯一键时各数据库对可空列行为不同，采用 `String @default("")` 归一，仍需以真实迁移验证。
- Windows 解压前条目枚举能力（`archive.ts:13-62`）需实现前验证，不得假设 `tar.exe` 支持 zip 列目录。
- 预检/组装须保证 `server/node_modules/prisma` 等相对路径完整（preStart 以 `shell:true` 在 `join(versionDir, artifact.dir)` 执行）；`zipPath` 按 `<version>-<kind>-<random>` 隔离避免并发冲突。
- 新端点若沿用 `@Public`，清单本身不含密钥，但不得因端点公开而放宽信任边界。

**迁移与运维**：按 `docs/compatibility.md:104-119` 完成破坏性变化四件事（本 ADR、提升 `CONTROL_PROTOCOL_VERSION`、明确升级路径、`CHANGELOG.md`）。用随 Client Release 分发的 `scripts/upgrade-launcher.cjs` 一次性迁移存量机，先替换 `<app-dir>/dist/main.js` 再发布新构件；升级顺序沿用 `docs/compatibility.md:61-75`（上传 → Server 停派 Job 等收敛 → Server Launcher 更新 → 新 Server 恢复 → 在线 Client 逐台 → 离线 Client 补更，瞬时失败最多 3 次有界重试）。新增可选字段的白名单保留 ≥1 个发布周期。

**与既有 ADR 的关系**：不修改 ADR-0012／0019 的 Accepted 结论与状态，本 ADR 扩展其构件格式与整包完整性契约；ADR-0006:71 要求的重新评估在本期仅限**下载侧**，上传侧数据面留阶段二；ADR-0051 的有限重试与回退语义不变。

**后续义务**：同步 `docs/design/release-and-update.md`、`docs/compatibility.md`、`docs/deployment.md`、`docs/operations.md`、`docs/testing.md`、`docs/security.md`、`CHANGELOG.md`；按实现范围条件同步 `docs/architecture.md`／`docs/protocols.md`／`docs/domain-model.md`／`docs/roadmap.md`／`skills/vcpdeck/SKILL.md`／`scripts/README.md`。阶段二（上传侧增量、全局块去重、停旧格式、`CONTROL_PROTOCOL_VERSION` 的 N-1 收敛）以 `docs/roadmap.md` 明文条目跟踪，并另起 ADR 重评 ADR-0006:71。

## 验证与退出条件

沿用 `docs/compatibility.md:161-176` 发布门禁，并新增/强化：打包侧 `collectFiles` hash/size/mode 与 delta 差集（增/删/改/权限变化）、基线清单缺失退化、多基线产物命名；签名验签通过/篡改拒绝/公钥轮换演练与规范化字节一致性；路径预检的 `..`、绝对路径、盘符、空字节、符号链接、越界与非清单条目；Launcher delta `prepare` 全链路（选包→整包校验→解压→预检→验签→硬链接组装→逐文件校验→chmod）、基线缺失/hash 不符降级 full、`isPrepared` 幂等、apply 时序不变、探活失败回退、并发 prepare 隔离；Server/CLI 多产物会话唯一键、齐备前不得 `startRelease`、新端点 `LAUNCHER_UPGRADE_REQUIRED`、旧 `/file` 行为不变、`@Public` 不泄露敏感信息；兼容面跨版本注册矩阵（用上一发布版本真实载荷）、旧 Launcher 收 full 正常、旧 Launcher 收新端点明确拒绝、离线补更、硬链接共享后 retention 不破坏 current、Linux 可执行位、preStart 相对路径；运维面回退演练、cleanup preview、archive 三态分流、`retention.json` 损坏保护。

**状态从 Proposed 转 Accepted 的退出条件**：上述门禁全绿 + ≥2 个真实发布周期演练 + 存量 Launcher 迁移完成 + 回退与新装机演练通过。**停旧格式**（不再产 full 兼容包）另需：连续 2 个发布周期无旧格式下载，且由后续 ADR 宣布，不设硬截止。

**实施状态（2026-11-12）**：代码已按本 ADR 落地，单元与集成门禁全绿（`scripts/tests/unit` 25 项，Server／Launcher／Shared／CLI 既有测试与构建通过），`docs/design/release-and-update.md` 已按实现的 `/file?fromVersion=` 口径更正。状态**仍为 Proposed**：真机发布周期演练、存量 Launcher 迁移、回退与新装机演练均未执行，因此本文与 `docs/adr/README.md` 的状态不得被引用为 Accepted 结论。实施顺序存在偏差——实现先落盘、测试后补，未保留严格的 RED→GREEN 记录。（2026-11-12 补记）签名信任根已闭环：打包从签名私钥派生公钥并注入 Launcher 单文件，包内只含公钥；`VCPDECK_RELEASE_PRIVATE_KEY_PEM`／`VCPDECK_RELEASE_PRIVATE_KEY_PATH` 缺失即打包失败。`/update` 端点当前没有 Launcher 消费方，实际链路是编排器随 `UpdateRequest` 下发候选、Client 转交 `/prepare`；该端点接线或删除需在转 Accepted 前决定。增量包生产已接入打包主流程：每次发布写同版本 sidecar 清单，并以输出目录里最近 3 个历史 sidecar 为基线求差集，产出 `vcpdeck-<version>-<platform>-delta-<fromVersion>.zip`；变更集为空或变更量不小于全量包时跳过。旧发布包 `manifest.json` 无 `files` 字段，无法充当 Launcher 基线，因此首个带 sidecar 的版本不产 delta，端到端仍待真实发布周期验证。（2026-11-12 补记）已完成 1 次真实自更新演练：本机以 0.23.4 Server 起步，先替换为 0.23.6 Launcher，再用 CLI 上传 0.23.6 双平台构件，Server 经 `/prepare`→`/apply` 自动切换到 0.23.6，重启后 `/api/status` 与 `apps/state.json` 均为 0.23.6；演练同时暴露并修复了 `/apply` 在 prepare 进行中直接 409 的跨版本缺陷。演练只覆盖 1 个周期，且因旧 Server 不支持增量会话，delta 构件被跳过、未参与真实切换，仍不满足 ≥2 周期、存量 Launcher 迁移与回退/新装机演练的转 Accepted 条件。（2026-11-12 补记）生产第二周期已完成：生产 Server 宿主机先把 Launcher 替换为 0.23.6（旧包备份保留），再用 CLI 上传 0.23.6 双平台构件，Server 于当日 17:50 经 `/prepare`→`/apply` 自更新，新 Launcher 验签通过后启动 0.23.6；18 台客户端全部升到 0.23.6（online 18 / outdated 0），存量 Launcher 迁移随该轮完成（服务端 1 台 + 客户端 17 台）。仍缺回退演练与新装机演练，且 delta 尚未参与真实切换（生产基线为 0.23.4，本地构件只对 0.23.6 基线产出 delta），因此状态继续维持 Proposed。

**何时重新评估**：出现下列任一情况应创建新 ADR 重新评估，而非直接改本 ADR 结论——上传侧引入全局块去重（重评 ADR-0006:71 数据面边界）、签名信任根/密钥轮换模型变化、delta 窗口（最近 3 个成功版本）与 `RELEASE_CLEANUP_POLICY` 脱钩、或宣布停旧格式。
