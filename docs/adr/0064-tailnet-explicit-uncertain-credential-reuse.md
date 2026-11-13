# ADR-0064：Tailnet 凭据在操作者显式确认后允许重试 `uncertain` 记录

- 状态：Accepted
- 日期：2026-11-13
- 决策者：项目维护者
- 关联：[ADR-0062](./0062-tailnet-job-network-under-existing-architecture.md)、[ADR-0004](./0004-typed-job-kernel.md)、[ADR-0009](./0009-trusted-operator-security-domain.md)、[ADR-0038](./0038-git-ssh-distribution-under-shared-psk.md)

## 背景

ADR-0062 规定「一次性 key 不得批量复用；结果不明时不得自动恢复为可安全重用」，实现上体现为凭据状态机 `available → reserved → spent | available`：密钥正文向 Client 交付后，无论任务成功、失败、取消还是结果不明，`reusable` 凭据只在任务 `done` 时释放；其余情况一律落 `uncertain`，既不自动回到 `available`，也不允许再次预留。

这条规则保护了一次性密钥不被重复下发，但也把一类真实场景挡死：操作者在导入时明确声明为「可复用」的 Auth key，在 Tailscale 侧仍然有效（未过期、未被撤销），而 VCPDeck 里对应的记录因为一次失败或中断永久不可用。此时唯一出路是「删除旧记录 + 重新导入同一串 key」——这既不产生任何安全收益（下发的是同一份正文），又丢掉了「这次为什么重试」的上下文，且记录越堆越多。

问题在于状态机缺少一个表达「操作者已经知情并承担该次下发的后果」的入口，而不是缺少自动重试。放开必须是有意识的、逐次的、可审计的决定，不能是系统行为。

## 决策

1. **确认是逐次且显式的。** `tailnet.manage` 的 `ensure` 载荷新增可选布尔字段 `allowUncertainReuse`；缺省或 `false` 时维持现状（`TAILNET_KEY_BUSY`）。该字段属于跨运行时协议，定义在 `packages/shared/src/tailnet.ts` 的解析器中，未知字段与非布尔值照旧拒绝，不做宽松猜测。

2. **只对「声明为可复用」的凭据生效。** `declaredReuse !== "reusable"`（`single` 或 `unknown`）的凭据即使带上确认也不复用——无法排除一次性密钥已被消费，重试只会把「结果不明」变成「确定失败」，不解决问题。确认不改变声明本身的含义：声明仍是操作者的话，不是可靠观测。

3. **服务端在预留事务内做原子条件更新，状态机只扩一条边。** 允许复用时条件从 `use = available` 放宽为 `use ∈ {available, uncertain} AND declaredReuse = reusable AND reservedJobId IS NULL`；命中后仍是 `uncertain → reserved`。不新增 `available` 自动回流路径，不因确认次数改变终态：再次失败依旧落 `uncertain`。

4. **审计落在既有的 Job 与凭据字段上。** 不需要新表或新列：Job 载荷持久化了 `allowUncertainReuse` 与 `credentialId`，凭据的 `reservedJobId`、`issuedAt`、`use` 记录每次下发。任何一次复用都能从 Job 记录追到具体凭据与时间，满足 ADR-0009 的可信操作者模型。

5. **入口必须在文案上说明前提。** 机器页在没有可用凭据、但存在「可复用 + `uncertain`」记录时提供确认复选框（默认不勾选），文案要求操作者确认该 key 未过期且未被撤销；CLI 对应 `--allow-uncertain-reuse`。不提供「自动重试」「静默复用」或批量开关。

6. **不放宽任何密钥保护边界。** 正文仍只经既有受控通道单次交付，不进入 Job 载荷/结果/日志，Client 仍用受权限保护的临时凭据并在各终止路径清理；确认字段本身不携带任何密钥信息。

## 候选方案

- **自动重试 `uncertain` 记录**：最省事，但会把一次性密钥重复下发，直接违背 ADR-0062 的 fail-closed 结论；不可接受。
- **维持现状，只靠「删除后重新导入」**：安全，但丢失审计上下文，且对可复用密钥没有任何收益；用户已明确要求改进。
- **允许所有声明类型复用**：把「未知」当成「可复用」，是典型的宽松猜测；不采用。
- **新增「重试次数」或「永久解锁」状态列**：引入与 Job 载荷重复的记账，且无法表达「逐次知情」；不采用。

## 后果

- 协议增量集中在 Shared：Server、Client、SDK、CLI、前端需同步升级；旧 Server 忽略该字段时仍返回 `TAILNET_KEY_BUSY`，旧调用方不带该字段时行为不变，因此兼容性是单向且安全的。
- 状态机多一条受控边，`tailnet-key.service` 的预留条件与错误文案需覆盖「已确认但仍不可复用」的情形（例如 `single` 凭据 + 确认 → 明确说明一次性密钥不能复用）。
- 需要测试覆盖：可复用 + `uncertain` + 确认 → 预留成功；一次性/未知 + 确认 → 仍 `TAILNET_KEY_BUSY`；无确认 → 维持现状；确认字段非法值被解析器拒绝；前端只有勾选后才启用按钮。
- 需要更新 `docs/operations.md` 的凭据状态说明、错误码排查与 CHANGELOG；ADR-0062 的后果第 4 条不修改，本 ADR 是对它「不得**自动**恢复」的补充解释。
- 残余风险：操作者可能在 key 已被撤销或过期时误点确认。后果是一次明确失败的 `TAILNET_JOIN_FAILED` 与再次 `uncertain`，不会产生错误的安全承诺；文案与文档必须把这条前提写清楚。

## 验证与退出条件

- 自动测试覆盖上述分支，并证明不带确认时既有 fail-closed 行为逐字不变。
- 真机验证一次「可复用 key 在 `uncertain` 后经确认重试」的完整链路（含失败路径），确认凭据终态与 Job 记录如实反映结果。
- 若将来需要自动重试、按 key 有效期做前置校验（例如调用 Tailscale API 查询 key 状态），或把确认扩展到一次性密钥，应另立决策，不静默扩展本 ADR。
