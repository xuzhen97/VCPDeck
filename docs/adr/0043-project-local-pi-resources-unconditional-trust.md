# ADR-0043：项目本地 Pi 资源无条件加载

- 状态：Accepted
- 日期：2026-10-10
- 决策者：项目维护者
- 实施状态：待实施；Accepted 表示决策已批准，不表示加载面已放开。
- 关联：[ADR-0029](./0029-server-managed-isolated-pi-runtime.md)、[ADR-0040](./0040-pi-extension-web-interaction.md)、[ADR-0042](./0042-standard-pi-community-extensions.md)、[`remote-pi-control-plane.md`](../design/remote-pi-control-plane.md)

## 背景

现有实现刻意关闭全部项目本地资源发现：`agent-session.ts:bundleLoaderOptions()` 恒设 `noExtensions / noSkills / noPromptTemplates / noContextFiles: true`，并令 `resolveProjectTrust: async () => false`（ADR-0029 决策 7）。远程 Pi 因此只加载随 Client Release 发布的受信 Bundle。

但项目目录里的 `.pi/`、`.mcp.json`、`AGENTS.md`、项目 skills 与 prompt 模板属于**项目自身的特性**：项目靠它们声明自己的工具、MCP 服务器与协作约定。不加载它们，远程 Pi 就无法正确开发该项目——这与"隔离用户原生 Pi"是两个不同的边界，不应混为一谈。

ADR-0029 决策 7 曾预留条件："未来如允许项目本地资源，必须新增明确 Server policy/审批语义，并保证审批状态不落入用户原生 Pi trust store"。维护者评估后选择**更直接的路径**：项目资源无条件加载，不引入 policy 或审批。本 ADR 记录该取舍并要求修订那条决策的适用范围。

## 决策

### 1. 项目本地资源无条件生效

放开 `noExtensions / noSkills / noPromptTemplates / noContextFiles`，保留 `additionalExtensionPaths` 继续加载受信 Bundle；`resolveProjectTrust` 由宿主恒返回真，且**不读写原生 `ProjectTrustStore`**。

项目目录中的 `.pi/extensions`、`.agents/skills`、prompt 模板与上下文文件按 SDK 既有发现规则生效，无需任何审批。**不采用 ADR-0029 决策 7 预留的 Server policy/审批语义**；该条应修订为指向本 ADR。

### 2. 全局 Pi 环境仍然零占用

放开项目发现**不得**演变为触碰全局环境：

- 不使用原生 trust store，信任由宿主钩子直接给出；
- `agentDir` 仍是 VCPDeck 数据根，**不指向原生 `~/.pi`**；因此 SDK 的用户级资源发现只可能落在我们自己的数据根内，不构成对全局 Pi 的占用；
- 来自 `~/.pi` 的可执行资源永远不加载；
- 现有 native Pi 零污染门禁（递归清单 + 内容 hash）继续作为强制验收。

### 5. VCPDeck 数据根是第二个扩展来源（已接受的例外）

移除 `noExtensions` 后，SDK 也会发现 `<VCPDeck 数据根>/extensions` 下的扩展。该目录属于 VCPDeck 自己的数据根，**不是**用户原生 Pi 的安装结构，因此不构成“污染全局 Pi”，**不封禁也不加守卫**。

但必须明确记录：扩展由此存在**两条来源**——随 Release 交付的受信 Bundle（版本固定、逐资源校验、跨机一致），与本机数据根下的扩展目录（无版本、无校验）。后者**会让同版本 Client 之间行为不同**。这是对“扩展随发包交付以保证环境一致”的显式例外，不得在任何文档、界面或验收结论中声称两者等价。

### 3. 与终端形态无关的加载面保持关闭

`noThemes: true` 继续生效（终端主题与 rpc 模式的网页交互无关）；内置扩展（`builtin:mcp` 等）继续排除，MCP 能力由另行确认的受信扩展承担。

### 4. 允许读机器全局 MCP 配置（显式例外）

选定的 MCP 扩展会读 `<home>/.config/mcp/mcp.json`、`<home>/.agents/mcp.json`、Pi 全局 MCP 配置，以及宿主工具配置（cursor/claude/codex/windsurf/opencode）。

**这是"所有 Client 环境一致"的显式例外**：同一 Client Release 在不同机器上可能加载不同的 MCP 服务器集合。任何文档、界面或验收结论都不得声称 MCP 服务器集合跨机一致。

## 候选方案

1. **新增 Server policy + Owner 审批 + 审计**（ADR-0029 决策 7 的预留路径）：安全性更好，但引入跨运行时协议、状态与界面，且审批状态需要新的持久化权威。维护者判断当前是少量可信操作者的单信任域（ADR-0009），不值得为此扩大控制面；不采用。
2. **维持全部关闭**：与"项目自身特性要生效"的目标直接冲突；不采用。
3. **只放开不可执行资源（context 文件、skills），继续禁止项目扩展**：折中方案，但项目扩展正是开发中最需要的部分，且 `.pi/settings.json` 同样能间接执行；半开反而制造难以解释的边界；不采用。

## 后果

正面：项目自身约定的扩展、MCP 服务器、技能与上下文在远程 Pi 中按预期生效，远程开发与本地 `pi` 行为不再分叉；信任判定仍不落原生 trust store，全局隔离边界不受损。

负面与风险：

- 项目 `.pi/extensions` 是**可执行代码**，以 Client OS 账户权限运行；Windows 部署为 SYSTEM、Linux 为 root 等价账户。克隆一个含恶意 `.pi/extensions` 或 `.pi/settings.json` 的仓库，即等于在 Client 上获得代码执行。**这不是沙箱，项目目录内容自此属于可执行输入。**
- 项目 skills 与 prompt 模板会引导模型执行程序，属中等风险，同样无条件生效。
- 同一 Client 在不同项目下的能力面不同，这是预期行为，但排障时必须先确认"是哪个项目的资源在生效"。
- 远程 Pi 与用户在**同一项目**下运行的原生 `pi` 会加载同一批项目资源，但两者的全局配置仍完全分离。

## 验证与退出条件

- 项目 `.pi/extensions` 中的扩展被加载，其命令/工具在会话中可见；`AGENTS.md`、`.agents/skills`、prompt 模板按 SDK 规则生效。
- native Pi 零污染门禁继续全绿：预置 `~/.pi` 的 settings/models/credentials/session/可执行扩展后，跑完会话的递归清单与内容 hash 零变化。
- `agentDir`（VCPDeck 数据根）内的用户级资源不被加载；原生 trust store 预置内容 hash 不变。
- 文档明确写出"MCP 服务器集合可能跨机不同"，不得声称一致。

若未来要求对项目可执行资源引入审批、审计或供应链约束（例如出现跨信任域、多租户、合规要求，或目标机器不再由少量可信操作者独占），应新增 ADR 重新评估本决策，不静默收紧或放宽。
