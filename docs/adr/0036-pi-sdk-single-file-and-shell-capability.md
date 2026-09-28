# ADR-0036：Pi SDK 单文件发布与 shell 能力平台化

- 状态：Accepted
- 日期：2026-09-28
- 决策者：项目维护者
- 关联：[ADR-0029](./0029-server-managed-isolated-pi-runtime.md)、[ADR-0030](./0030-pi-resource-bundle-and-tool-policy.md)、[ADR-0012](./0012-bundled-release-artifacts.md)、[`docs/design/remote-pi-control-plane.md`](../design/remote-pi-control-plane.md) §16、[`docs/protocols.md`](../protocols.md)

## 背景

Client 以 SYSTEM 计划任务运行在**不可控的目标机器**上，Pi 的能力探测必须在任意环境下得出正确结论。实测事故（机型 `syc`，0.12.0）暴露两个环境敏感点，都会把「环境差异」误判成「不支持 Pi」，且绑定后无法恢复：

1. **首开成本按文件数计费。** Release 的 Client 是真 `node_modules`（14,688 文件 / 162 MB），Pi SDK 的 ESM 图约 2,400 个文件。在带实时扫描的目标机上，**每个文件首次打开约 19.6 ms**（同批文件重读仅 0.41 ms，C: 为 NVMe SSD，已排除存储层）。由此冷加载 47,779 ms，稳定超过 worker 超时，Client 上报 `PI_RUNTIME_UNAVAILABLE — Pi probe worker timed out`，Server 记为 `PI_CLIENT_UNSUPPORTED`，机器永久不可用。
2. **Bash 被当成整机门禁。** Windows 上找不到 Git Bash 即 `available:false`（`PI_BASH_NOT_FOUND`），实测 `gs-local`、`gs-shanxi` 两台因此完全不能使用 Pi。但 Pi SDK 的 `bash` 与 `powershell` 是并列的内置工具（`PI_BUILTIN_TOOL_IDS` 已含 `powershell`），POSIX 无 bash 时还会退到 `sh`；`powershell.exe` 是 Windows 组件，实际上并不缺。
3. **失败被放大成永久状态。** `forkProbeWorkerOnce` 缓存失败结果、worker 的 `exit` 只清定时器不收敛 Promise，因此一次性抖动或子进程崩溃都会表现为同一个超时消息，且直到进程重启都不可恢复；Server 侧还把 Client 的真实原因码统一覆盖成 `PI_CLIENT_UNSUPPORTED`，失去唯一远程诊断线索。

约束：不改动 Server 权威模型、不读宿主用户 Pi、不引入新运行组件，插件（Bundle 扩展）加载能力不得受影响。

## 决策

1. **Pi SDK 以单文件产物发布。** 构建期用 esbuild 把 `@earendil-works/pi-coding-agent` 及其依赖打成单个 ESM 文件（`define: { PI_BUNDLED_NODE: "true" }` + 注入 `createRequire`），写入 `client/node_modules/@earendil-works/pi-coding-agent/`（`index.mjs` + 自带 `package.json`，版本与该包声明一致）。Client 源码里的 `import("@earendil-works/pi-coding-agent")` 不加改动，运行时按包名命中该单文件。它不再进入依赖安装清单，包的其余 `pi-*` 依赖全部内联。
2. **`PI_BUNDLED_NODE` 走 SDK 自带的嵌入模块路径**（`dist/core/extensions/virtual-modules.js`）。这是 SDK 为「编译后运行时」设计的官方分支：扩展（插件）运行时 `import "<Pi SDK 包名>"`、`typebox` 等解析到内存模块，**不依赖目标机 node_modules**。这是「不影响后续插件系统」的实现依据，必须随 SDK 升级回归验证。
3. **Bash 不是整机门禁。** shell 缺失只影响 `shellKind` 诊断值与工具集合：
   - Windows 默认可用 `powershell`，检测到 Git Bash 才额外提供 `bash`；
   - POSIX 由 SDK 自身退到 `sh`；
   - 会话装配时按平台可用性过滤 `tools`，不把本机不存在的 shell 工具留给模型。
4. **shell 解析由 VCPDeck 自己做，绝对路径优先。** 新增 `packages/client/src/pi/shell.ts`，候选顺序覆盖 SDK 自身的解析（含此前漏掉的 `%ProgramFiles(x86)%\Git`）与 `%SystemRoot%\System32\WindowsPowerShell\v1.0`。解析结果分两处使用：启动时把 shell 目录前置到进程 PATH（SDK 的 PowerShell 解析只走 `where`/`which`），并把 bash 绝对路径注入 `Settings.shellPath`（SDK 构造 bash 工具时读取）。
5. **能力探测的失败必须可诊断且不粘滞。** worker 失败结果不进入进程内缓存；worker 静默退出、启动失败、超时是三个不同的消息；Server 保留 Client 上报的真实原因码（`PI_NODE_UNSUPPORTED` / `PI_BASH_NOT_FOUND` / `PI_RUNTIME_UNAVAILABLE` 等），只对「未上报 / 协议不匹配」保留 `PI_CLIENT_UNSUPPORTED`；前端补齐原因码文案。
6. **能力探测的时限只用于兜住卡死。** 单文件产物把真实成本降到「一次文件打开 + 解析」（实测约 0.36–0.5 s），因此 worker 上限与 REGISTER 等待预算按此设定，不再需要为「首开慢」留量。

## 候选方案

- **给每台机器加杀软排除项 / 让运维逐台处理**：只把 19.6 ms 压回 0.4 ms，是 O(机器数) 的运维债，且掩盖探测与状态机的缺陷；不采用为方案，仅作为临时救急。
- **只删掉能力探测，把兼容性完全交给 RuntimeSpec ACK**：能消除误判，但会丢掉 `modelCatalog` 建议来源与「SDK 可加载」的声明期验证，且改动跨运行时语义更大；不采用。
- **只放宽超时**：不改变「按文件数计费」的成本结构，慢机器仍会随文件数增长而失败；不采用。
- **把整个 Client 主进程改为 ESM 产物**：可保留 `import.meta.url` 语义，但 `__dirname` 依赖与 fork worker 布局都要改，风险远大于收益；不采用，改为把 Pi SDK 单独打成 ESM 单文件。

## 后果

- 任意目标机（含带实时防护、冷盘、慢 CPU）的能力探测只付一次文件打开；Pi 不再因环境差异被永久禁用。
- 无 Git Bash 的 Windows 机器可完整使用 Pi（PowerShell 工具），`shellKind` 不再是可用性判据。
- Release 体积显著下降（Pi SDK 依赖树不再随包分发），安装与回滚更快。
- 失败原因码成为远程可诊断事实，不再需要登机器现查。
- 风险：单文件产物依赖 SDK 的嵌入模块分支与 `dist` 布局；SDK 升级必须回归「扩展加载 + 插件运行时导入 + `VERSION` 一致」三项。
- 风险：`PI_PACKAGE_DIR` 等包内资源路径在打包后指向产物目录（VCPDeck 不使用 TUI/主题/docs 相关入口；若未来需要，需在产物目录补齐资源）。

## 验证与退出条件

- 单元：能力探测在「无 bash」下仍为 `available:true`；shell 解析覆盖 Git(x86)、PowerShell 绝对路径与 PATH 回退；工具按平台过滤；`scripts/pack-release-deps.test.ts` 断言 Pi SDK 不在依赖安装清单且 esbuild 仍将其保留为 external。
- 集成：真实 `probe-worker` 在单文件布局下报出正确 `sdkVersion` 与 provider 目录（实测 357 ms）；`discoverAndLoadExtensions` 能加载 Bundle 扩展；扩展运行时 `import "<Pi SDK 包名>"` 与 `typebox` 可从内存模块解析（插件系统回归）。
- 端到端：对实测事故机验证「探测通过 → 绑定成功 → 下发 Spec → ready」；无 bash 机器验证 PowerShell 工具可用、`bash` 不出现在工具集合。
- 退出条件：若 SDK 移除嵌入模块分支、改变 `exports`/`dist` 布局，或扩展加载必须依赖磁盘 `node_modules`，重新评估本决策。
