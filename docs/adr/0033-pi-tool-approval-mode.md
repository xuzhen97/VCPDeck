# ADR-0033：Pi Tool Policy 与 Execution Mode 分层

- 状态：Accepted
- 日期：2026-09-24
- 决策者：项目维护者
- 关联：[ADR-0029](./0029-server-managed-isolated-pi-runtime.md)、[ADR-0030](./0030-pi-resource-bundle-and-tool-policy.md)、[`docs/design/pi-tool-approval-mode.md`](../design/pi-tool-approval-mode.md)、[`docs/design/remote-pi-control-plane.md`](../design/remote-pi-control-plane.md)

## 背景

当前 VCPDeck Pi 已实现 `allow / confirm / deny` 三桶工具策略，并由随 Client Release 发布的 `vcp.tool-policy` 扩展在 `tool_call` 前执行策略。当前 `confirm` 的语义是**每次调用都请求 Extension UI 审批**，因此只要 `bash`、`write`、`edit` 等工具位于 `confirm`，自动化任务就会在每次工具调用时进入 `waiting_input`。

这一行为符合 ADR-0030 的安全默认，但不适合 VCPDeck 的主要自动化场景：用户往往希望保留“哪些工具属于敏感能力”的分类，同时在可信环境中允许这些工具自动执行；需要人工监督时，再把同一套 Profile 切回审批模式，而不是反复重写工具桶。

现有架构已经具备实现这一目标所需的边界：

- Server 是 Profile、Tool Policy 和 RuntimeSpec 的权威；
- `allow ∪ confirm` 已经是 Pi SDK 的工具白名单，`deny` 同时进入 `excludeTools`；
- `vcp.tool-policy` 已经在真正执行工具前拦截 `tool_call`；
- Tool Policy 通过 Worker 进程内 host bridge 传给 Bundle 扩展；
- RuntimeSpec 变更会触发 Worker revision 换代，活跃 Run 不热替换策略。

因此本决策不引入新的权限系统，而是在现有 Tool Policy 上增加独立的 Execution Mode，并明确区分 Approval、Auto 与 YOLO。

- [ADR-0030](./0030-pi-resource-bundle-and-tool-policy.md) 的默认拒绝与审批语义继续作为 Approval/Auto 的策略基础；本 ADR 仅增加独立的 Execution Mode，并在 YOLO 中明确绕过 Tool Policy。
- 经设计评审确认采用 RuntimeSpec v4 硬切换，不提供 v3/v4 双协议回退；版本错位时 Pi fail closed。

## 决策

### 1. Tool Policy 与 Execution Mode 是两个独立维度

Tool Policy 继续回答：

> 这个工具是否属于当前 Profile 可使用的能力面？

Execution Mode 回答：

> 当前 Runtime 应按 Tool Policy 执行、自动执行策略允许的能力，还是直接信任本 Runtime 已加载的全部工具？

Profile 新增：

```ts
export const PI_TOOL_EXECUTION_MODES = ["approval", "auto", "yolo"] as const;

export type PiToolExecutionMode =
  (typeof PI_TOOL_EXECUTION_MODES)[number];
```

以及：

```ts
toolExecutionMode: "approval" | "auto" | "yolo";
```

### 2. 三种模式的确定语义

决策矩阵固定为：

| Tool Policy | `approval` | `auto` | `yolo` |
| --- | --- | --- | --- |
| `allow` | 直接执行 | 直接执行 | 直接执行 |
| `confirm` | 每次调用审批 | 直接执行 | 直接执行 |
| `deny` | 阻塞 | 阻塞 | 直接执行 |
| 未出现在任何桶 | 阻塞 | 阻塞 | 直接执行，但仅限 Runtime 已实际注册/加载的工具 |

三种模式的含义固定为：

```text
approval = 策略控制 + confirm 人工审批
auto     = 策略控制 + 无人工审批
yolo     = 跳过 Tool Policy 限制 + 无人工审批
```

YOLO 不是“信任目标机器上的一切”。它只关闭 VCPDeck **Tool Policy 这一层**，不绕过 RuntimeSpec、Resource Bundle 信任、项目资源默认关闭、Provider/Model Policy、VCPDeck Pi 数据隔离、Client OS 权限或未来独立的 Risk Guard。

YOLO 的可执行集合定义为：

> 当前 VCPDeck Pi Runtime 已经通过自身代码、平台支持和已启用的受信 Bundle Resources 实际注册/加载的工具集合。

它不会自动加载未启用 Extension，不会因为磁盘上存在 `.pi/extensions` 就扩大能力，也不会授予 Client 进程本身没有的 OS 权限。

等价决策函数：

```ts
type ToolDecision = "allow" | "approve" | "deny";

function resolveToolDecision(
  mode: PiToolExecutionMode,
  policy: PiToolPolicy,
  toolName: string,
): ToolDecision {
  if (mode === "yolo") return "allow";
  if (policy.deny.includes(toolName)) return "deny";
  if (policy.allow.includes(toolName)) return "allow";
  if (!policy.confirm.includes(toolName)) return "deny";
  return mode === "auto" ? "allow" : "approve";
}
```

在 `approval` / `auto` 中，`deny` 与未列出工具继续 fail closed；在 `yolo` 中，Tool Policy 不参与最终许可判定，但工具仍必须已经被 Runtime 实际注册。

### 3. RuntimeSpec 升级到 v4

Execution Mode 会改变 Client 实际执行工具的行为，因此属于 RuntimeSpec 安全语义，不能作为 v3 的可选扩展字段偷偷加入。

新增：

```ts
interface PiRuntimeSpecV4 {
  schemaVersion: 4;
  // 既有字段省略
  toolPolicy: PiToolPolicy;
  toolExecutionMode: PiToolExecutionMode;
  runtimeRevision: string;
}
```

Shared 必须提供严格 `parsePiRuntimeSpecV4()`；未知模式、缺失字段、未知顶层字段或旧 `schemaVersion` 一律按不兼容处理。

Server 只向明确上报支持 RuntimeSpec v4 的 Client 下发 v4。新 Server 与旧 Client 的组合不得 fallback 到 v3 后忽略 Execution Mode。

### 4. host bridge 升级到 v2

现有 Worker → Bundle 扩展进程内桥接从：

```ts
{
  bridgeVersion: 1,
  toolPolicy
}
```

升级为：

```ts
{
  bridgeVersion: 2,
  toolPolicy,
  toolExecutionMode
}
```

Bundle 扩展只接受 bridge v2；缺失、版本不符或形状非法时继续以 `PI_POLICY_UNAVAILABLE` 阻塞所有工具调用，不得假设默认模式。

策略与模式仍然只存在于 Worker 内存，不落盘、不进入环境变量。

### 5. `vcp.tool-policy` 资源升级到 v2

`vcp.tool-policy` Bundle 资源版本从 `1` 升到 `2`。Bundle manifest 自身的结构没有变化，因此 `PI_BUNDLE_PROTOCOL_VERSION` 不因本功能升级。

资源 v2 在 `tool_call` 时：

1. bridge 不可用 → `PI_POLICY_UNAVAILABLE`；
2. `yolo` → 不检查桶，直接放行；
3. `deny` 或未列出 → `PI_TOOL_POLICY_DENIED`；
4. `allow` → 直接放行；
5. `confirm + auto` → 直接放行；
6. `confirm + approval` → 调用 `ctx.ui.confirm()`；
7. 拒绝、取消或超时 → `PI_TOOL_POLICY_REJECTED`。

Client 的 SDK 工具选择也必须遵循同一语义：`approval` / `auto` 继续只暴露策略允许的内置工具；`yolo` 则不再用三桶缩小内置工具集合，而是暴露当前平台和受信 Runtime 实际支持的全部工具。不能只修改 Bundle 拦截器而遗漏 SDK 的前置工具白名单。

### 6. Worker 内的模式在一次 RuntimeSpec revision 生命周期内不可变

Execution Mode 属于 Profile/RuntimeSpec 配置。Profile 修改继续通过现有 revision 机制生效：

```text
Profile revision 变化
    -> 新 RuntimeSpec / runtimeRevision
    -> idle Worker 淘汰
    -> active Worker 完成本 Run 后 drain
    -> 新 Worker 使用新模式
```

正在执行的 Run 不因用户在中途修改 Profile 而改变审批语义。

本版本不增加“当前 Session 立即切换模式”的热配置通道。

### 7. 迁移默认与新建默认分开

数据库迁移对既有 Profile 使用：

```text
toolExecutionMode = approval
```

以保持升级前 `confirm` 每次审批的行为，不在升级时自动扩大执行权限。

Frontend 新建 Profile 则显式默认：

```text
toolExecutionMode = auto
```

这是产品默认，不是协议安全默认。YOLO 必须显式选择；通过 API 创建但未显式提供模式时，Server 仍以 `approval` 作为保守默认。

### 8. `confirm` 桶继续保留

不会把 Auto 或 YOLO 实现为永久改写三桶内容。

`confirm` 继续表示：

> 这个工具属于可用能力面，但在人工监督模式下需要确认。

因此用户可以长期保持例如：

```text
allow   = read, grep, find, ls
confirm = write, edit, bash
deny    = ...
```

平时可以使用 `auto` 完成受策略约束的自动化，需要监督时切换到 `approval`；明确希望把当前 Runtime 的全部已加载工具交给 Agent 时切换到 `yolo`。三种模式之间切换都不需要重新配置工具分类。

### 9. Session override 与 Risk Guard 不属于 v1

以下能力延后：

- Session 级临时 `approval / auto / yolo` override；
- “Allow once / Allow for session”；
- Bash 命令级风险分类；
- 敏感路径、越界 cwd、提权、网络下载执行等 Risk Guard；
- 审批决策持久化审计。

未来 Session override 必须在 **Run 开始时固化有效模式**，不能让一个 Run 执行到一半改变审批语义。

Risk Guard 若实现，应成为独立于 Tool Policy / Execution Mode 的强制安全层，并允许对高风险调用强制审批或拒绝；`yolo` 也不得绕过它。

## 候选方案

1. **自动模式时把 `confirm` 全部改写为 `allow`**：实现简单，但会丢失“监督模式下哪些工具需要审批”的长期分类，且切换模式需要重写 Profile；不采用。
2. **只保留 Execution Mode，删除三桶策略**：会失去 Auto/Approval 下的能力分类，也无法在退出 YOLO 后恢复受控策略；不采用。
3. **`approval` 模式对所有 enabled 工具都审批**：语义简单，但会让 `read/grep/find/ls` 等低交互成本工具也频繁阻塞，且浪费现有 `allow / confirm` 分类；v1 不采用。
4. **Session 级模式直接热切换**：需要跨 Frontend、Server Run、Supervisor、Worker 和 bridge 引入新的可变运行状态，并定义中途切换语义；先不采用。
5. **Auto 与 YOLO 合并**：会让“受策略约束的无人值守自动化”和“完全信任当前 Runtime 工具集”无法区分；不采用。

## 后果

正面：

- Auto 自动化任务不再因为 `confirm` 工具逐次等待人工输入；
- YOLO 为可信自有机器提供真正的“当前 Runtime 全工具直接执行”语义；
- Tool Policy 配置不会因切换模式被改写，离开 YOLO 后原策略立即恢复；
- 原有 Tool Policy、Extension UI、Worker revision 与 Bundle 架构全部复用；
- 已有 Profile 升级后行为不变；
- 用户可在不重写工具分类的情况下切换自动化/监督工作方式。

负面与风险：

- RuntimeSpec 从 v3 升到 v4，Server 与 Client 必须协同升级；
- Bundle 资源与 host bridge 也需要同步版本升级；
- `auto` 下 `bash`、`write`、`edit` 等 confirm 工具会直接执行；
- `yolo` 下 `deny` 和未列出工具不再形成执行限制，任何当前 Runtime 已注册工具都可由模型直接调用，因此受信 Bundle 选择与 Client OS 权限成为更直接的安全边界；
- 本版本仍只能按“工具名”分类，不能区分 `git status` 与高风险 shell 命令。

## 验证与退出条件

实现必须至少证明：

- `auto + allow` 直接执行且不请求 UI；
- `auto + confirm` 直接执行且不请求 UI；
- `auto + deny` 与 `auto + unknown` 都阻塞；
- `approval + allow` 直接执行；
- `approval + confirm` 只有明确批准后执行；
- `approval + confirm` 的拒绝、取消、超时都不执行；
- `yolo + allow / confirm / deny / unlisted` 对 Runtime 已注册工具都直接执行且不请求 UI；
- YOLO 不会加载未启用 Bundle Resource 或项目本地 Extension，也不会扩大 Provider/Model Policy；
- bridge 缺失、版本错误或模式非法都 fail closed；
- 只支持 RuntimeSpec v3 的 Client 不会收到任何 Spec，下发端不会静默降级；
- Profile 模式变化在活跃 Run 中不热替换，下一 Worker revision 才生效；
- 数据库迁移后既有 Profile 的行为保持“confirm 每次审批”；
- Auto/YOLO 都不会改变用户原生 `~/.pi` 的零污染保证。

以下情况应重新评估本决策：Pi SDK 提供原生可配置 Approval Policy；VCPDeck 引入跨信任域/多租户；Risk Guard 成为强制安全层；Session 级 override 需要成为一等运行状态。

