# 功能目录（Feature Registry）

> 状态：Current｜维护责任：项目维护者｜最后核验：2026-10-18｜适用版本：`Unreleased`（0.20.1 之后）

本文描述已经落地的「功能条目」：它的权威归属、字段语义、状态机、REST 与 CLI 形态、UI 边界、已知偏移。长期决策意图见 [ADR-0056](../adr/0056-feature-registry-declared-contracts.md)；代码与 Prisma schema 是当前事实来源。

## 1. 问题与非目标

远程能力被逐个造在目标机器上，但建成之后的语义没有归属：`capabilities` 只有 `exec`、`file.*`、`terminal`、`frp` 这类原语；Job 只记录跑过什么；真实知识散落在人脑、Agent 记忆和目标机的 `SOP.md` 里。结果是每次复用都要重新读文档、重新试探，且无法回答「它现在还有没有效」。

**非目标**（v1）：不新增 Job 类型、不代理执行；不做后台探测；不建模网络可达性；不提供 UI 侧验证入口；不做条目版本历史、标签、全文检索、按身份隔离、硬删除。

## 2. 权威与归属

| 数据 | 权威 | 是否被注册覆盖 |
| --- | --- | --- |
| `capabilities` / `capabilityDetails` | Client 上报 | 是（每次注册覆盖） |
| `annotations`（ADR-0055） | 操作者/Agent 声明 | 否 |
| **功能条目** | 操作者/Agent 声明 | 否（Client 不感知、不上报） |

条目绑定一台 host `Client`（`clientId`），同一 `slug` 可存在于多台机器：`@@unique([clientId, slug])`。同一 slug 的多台 host 只有在 `scope=generic` 时才互为备援；`scope=machine` 的条目不得换机器顶替。

`scope` 是**语义分类**，不参与授权、不代表可达性；网络可达性由 FRP 与 `annotations.publicAddress` 表达，条目内不重复记录。

## 3. 数据与契约

表 `Feature`（见 `packages/server/prisma/schema.prisma`）：

| 列 | 语义 |
| --- | --- |
| `id` | `ft_` + 8 位随机串 |
| `slug` | 1–63 位小写 kebab-case，创建后不可改 |
| `clientId` | host 机器 |
| `scope` | `generic` \| `machine` |
| `invoke` / `verify` | 判别联合 JSON：`{kind:"command",command,timeoutSeconds}` 或 `{kind:"http",method,url,timeoutSeconds}` |
| `inputs` | 参数表 JSON，最多 20 项 |
| `output` / `notes` | 产物说明 / 长尾经验（≤2000 / ≤8000） |
| `status` | 意图：`draft` \| `active` \| `retired` |
| `lastVerifiedAt` / `lastVerifiedOk` / `lastVerifyEvidence` / `verifiedVia` | 证据：最近一次验证的时间、结果、摘要与来源 |
| `sourceJobId`、`createdByName/Via` | 审计 |

Shared 侧（`packages/shared/src/feature.ts`）是唯一契约：严格 parser（未知字段拒绝）、URL 拒绝 userinfo、命令/文本长度上限、`getFeatureFreshness` 与 `FEATURE_STALE_AFTER_DAYS = 14`。

## 4. 状态机与失败路径

```
(新建)                          → draft
draft  --verify ok-->           active
active --verify fail-->         draft
active/draft --verify ok-->     active（刷新证据）
draft/active --PATCH status=retired--> retired
retired --PATCH status=draft--> draft（复用前必须重验）
```

不变量：

- `active` **只能由一次成功验证产生**；REST、CLI、UI 都不提供写 `active` 的入口；
- 验证失败自动降级 `draft`（`retired` 不被验证复活）；
- `freshness` 读时计算（`never` / `fresh` / `stale`），只表达证据年龄，**不改变** `status`；
- 存储 JSON 损坏时只在投影层降级为 `draft` 并给出 `存储内容损坏`，不写回、不阻塞列表。

失败路径：未知 Client → 404 `FEATURE_CLIENT_UNKNOWN`；同机器同 slug → 409 `FEATURE_SLUG_TAKEN`；非法输入 → 400 `INVALID_FEATURE_INPUT`；手写 `active` → 400（parser 与 service 双重拦截）；未知条目 → 404 `FEATURE_NOT_FOUND`。

## 5. REST 与 CLI

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/features?clientId=&scope=&status=&page=&pageSize=` |
| `GET` | `/api/features/:id` |
| `GET` | `/api/clients/:clientId/features` |
| `POST` | `/api/features`（可内联 `verification`） |
| `PATCH` | `/api/features/:id`（只接受 `status: draft\|retired`） |
| `POST` | `/api/features/:id/verifications` |

CLI：

```bash
vcpdeck features list [--client=] [--scope=] [--status=] [--include-retired] [--json]
vcpdeck features get <slug|id> [--client=] [--json]
vcpdeck features add --client= --slug= --name= --summary= --scope= \
    (--invoke-command= | --invoke-url=) (--verify-command= | --verify-url=) \
    [--inputs-file=] [--output=] [--notes-file=] [--timeout=] [--skip-verify] [--json]
vcpdeck features verify <slug|id> [--client=] [--json]
vcpdeck features update <slug|id> [--client=] [字段...] [--status=draft|retired] [--json]
```

**验证由调用方执行**：`command` 型复用 `jobs run` 的 exec Job 并等待终态，`http` 型由 CLI 直连；结果经 `POST /:id/verifications` 记账。Server 与浏览器都不代验（SSRF / CORS）。`features add` 默认内联验证：通过即 `active`，失败仍落库为 `draft` 并以非零退出码报告证据。

`--inputs-file` 是 JSON 数组（对应 `FeatureInputParam[]`）：CLI 参数解析拒绝重复选项，因此不提供可重复的 `--input`。

## 6. UI 边界

- 机器工作区「功能」Tab（`/machines/:clientId/features`）与侧栏「功能」页（`/features`）共用 `machine-features-panel.tsx`；不传 `clientId` 时跨机器展示；
- 列表展示名称/slug、作用域、状态、证据年龄、提供机器；抽屉展示契约全文、参数、产物、备注与证据；
- 常驻提示：`active` 只代表声明；
- UI **不提供验证按钮**；抽屉给出可复制的 `vcpdeck features verify <slug> --client <name>`；
- UI 可切换 `draft` / `retired`，退役需二次确认；`active` 只读。

## 7. 安全与隐私

- 条目内禁止凭据；URL 拒绝 userinfo 与控制字符；
- 命令文本、内网 URL、`notes` 与验证证据都属于可能敏感的数据面，默认不在日志回显全文；
- 写入权限沿用单信任域模型（ADR-0009），`createdByName` 只是审计；
- `command` 型验证继承 host 的 OS 账户权限，**不是沙箱**。

## 8. 兼容、迁移与回滚

- 新增独立表、新 REST 域与前端口径：不触碰 Client 与注册协议，**不提升协议版本**；旧 Client 无感；
- 表随既有 `db push` 启动路径创建；本版只新增表，升级不需要 `--accept-data-loss`；
- 回滚：移除路由、表与前端入口即可；已发生的远端验证副作用（真跑过的命令）不回滚。

## 9. 已知偏移与限制

1. **证据依赖调用方**：`verifiedVia` 只说明谁上报，Server 不亲测；多身份环境无法区分行使人。
2. **不会自动变绿或变红**：无后台探测，`freshness` 只暴露年龄，不隐式改状态。
3. **UI 无验证入口**：刷新证据必须用 CLI/Agent。
4. **slug 不可改**：写错只能退役后重建。
5. **`inputs` 不做运行时校验**：只是给 Agent 的契约描述。
6. **离线机器按名称不可解析**：`features add/verify --client <name>` 依赖 `clients.list`（只含在线机器）；离线时请用 clientId 或候补。

## 10. 测试与验收

- `packages/shared/src/feature.test.ts`：上限、判别联合、URL userinfo、枚举参数、证据截断、新鲜度边界；
- `packages/server/src/feature/feature.service.test.ts`：`active` 只由证据产生、失败降级、`retired` 不复活、409/404、坏契约投影；
- `feature.controller.test.ts`：空 PATCH、手写 `active`、404、pageSize 夹取；
- `packages/sdk/src/features.test.ts`：路径与请求体映射；
- `packages/cli/src/features-command.test.ts`：`--status=active` 拒绝、多 host fail closed、JSON 输出、缺失条目；
- `packages/frontend/src/pages/machine-features-panel.test.tsx`：stale 文案、常驻警示、空态、行内容。

## 11. 与 ADR、其他文档的关系

- 决策意图：[ADR-0056](../adr/0056-feature-registry-declared-contracts.md)；
- 权威分离先例：[ADR-0055](../adr/0055-client-operator-annotations.md)；
- 写权限模型：[ADR-0009](../adr/0009-trusted-operator-security-domain.md)；
- 对外能力矩阵与 REST 细节：[`docs/integration-guide.md`](../integration-guide.md)；
- CLI 与 Skill 使用方式：[`skills/vcpdeck/SKILL.md`](../../skills/vcpdeck/SKILL.md)。
