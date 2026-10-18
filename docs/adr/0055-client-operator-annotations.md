# ADR-0055：Client 操作者注解与上报事实分离

- 状态：Accepted
- 日期：2026-10-18
- 决策者：项目维护者
- 关联：[ADR-0005](./0005-shared-contracts-and-communication-channels.md)、[ADR-0053](./0053-retire-p2p-tunnel-and-browser-remote-desktop.md)、[`domain-model.md`](../domain-model.md)、[`protocols.md`](../protocols.md)、[`compatibility.md`](../compatibility.md)

## 背景

Agent 与操作者需要知道一些 **Client 自己无法可靠上报、但对选机和远程操作很关键** 的事实，例如这台机器有没有公网 IP、公网地址是什么、有没有稳定域名。当前 `MachineRegister` 只承载 Client 自报的 `hostname`、OS、CPU、内存、版本和 capability；这些字段在每次注册/心跳时按 Client 上报值覆盖，没有操作者维护的稳定位置。

把这类信息塞进注册消息有两个问题：重连即被 Client 覆盖；等于允许 Client 冒充操作者做网络判断。因此需要明确区分两类数据权威，并给操作者一个不会被注册覆盖的补充入口。

## 决策

1. **权威分离**：`Client` 新增 Server 持有的 `annotations` JSON 列。Client 上报事实继续由 Client 权威并在注册时覆盖；操作者注解由 Server 持有，注册、心跳、重连和改别名都不得覆盖，Client 不得写入。
2. **v1 形状**：只保留三个字段：
   - `publicAddress: { v4: string[]; v6: string[]; host: string | null } | null`
   - `notes: string | null`
   - `updatedAt: string`（Server 写入，调用方不得伪造）
3. **三态语义**：
   - `annotations` 不存在 = 从未人工补充；
   - `publicAddress === null` = 补充过，但公网情况未声明；
   - `publicAddress` 内 `v4`/`v6` 为空且 `host === null` = 明确没有公网地址；
   - 任一地址或 `host` 有值 = 有公网地址。
   地址只做语法校验，**不验证可达性**；`publicAddress` 有值不等于端口可达。
4. **内容边界**：只收稳定、外部可知、决策相关、非秘密的信息。不得保存密码、密钥、令牌、Cookie 或其他凭据；不复制 FRP 实时映射（暴露状态仍以 `FrpMapping` 为准）；不保存 CPU/内存等实时指标。
5. **说明性事实**：注解不参与授权，不构成连通性保证，也不得作为调度或安全判定的唯一依据。v1 不做自动探测、不主动验证地址。
6. **REST 契约**：`PUT /api/clients/:clientId/annotations` 全量替换并返回 `ClientInfo`；空对象表示清除；非法输入返回稳定错误码 `INVALID_CLIENT_ANNOTATIONS`，未知 Client 返回 `CLIENT_NOT_FOUND`。`GET /api/clients` 响应新增可选 `annotations`，其余语义不变。
7. **兼容规则**：新增可选 REST 字段与带默认值的数据库列，属于通常兼容变更，不提升协议版本。旧 Server 不返回 `annotations` 时，CLI/UI 按“未补充”处理；旧 Client 不感知该字段。
8. **暂不引入**：`tags`、`updatedBy`、独立注解表、变更审计、离线机器列表、自动探测与可达性验证。出现真实消费方或多人协作需求后另立决策。

## 候选方案

- **放进注册消息**：实现最直接，但重连会被覆盖，且 Client 可以冒充操作者声明网络事实，不可接受。
- **自由 key-value 注解**：灵活，但没有稳定契约、无法做字段级校验，长期会腐化成无结构文本；v1 采用固定核心字段 + `notes` 承接长尾。
- **独立表保存注解与版本**：可支持历史与审计，但当前没有多版本、多操作者审计或回滚需求，增加迁移与查询面，YAGNI。
- **复用 `capabilityDetails`**：与能力探测语义混杂，注册时会被覆盖，也无法表达“操作者声明”的来源。
- **先做自动探测**：公网出口、NAT、防火墙可达性语义复杂，且离线机器无法探测；先提供人工声明入口，自动探测另立决策。

## 后果

正面：

- Agent 可以通过 `clients list --json` 获得稳定的公网地址与人类补充的关键上下文；
- 注册链路零改动，旧 Client 完全不受影响，兼容风险低；
- 数据权威清晰：上报事实与操作者声明不会互相覆盖。

负面与风险：

- 注解需要人工维护，可能过期；`updatedAt` 只表达声明时间，不证明现状；
- `notes` 可能被写入敏感信息，UI 必须提示“禁止填写密码/密钥/令牌”；
- 并发编辑采用 last-write-wins，v1 不提供冲突检测；
- 操作者可能把“有公网 IP”误读为“端口可达”，UI 与文档必须明确区分，并以 `notes` 说明。

验证与退出条件：

- Shared parser、Server 注册不覆盖、`ClientInfo` 投影、SDK/前端写入与 CLI 读取均需测试；
- `GET /api/clients` 旧消费者忽略新增字段仍可工作；
- 若出现按标签筛选、声明者审计、自动可达性验证或跨系统消费注解的确定需求，重新评估字段与存储模型，而不是在 v1 上静默扩张。
