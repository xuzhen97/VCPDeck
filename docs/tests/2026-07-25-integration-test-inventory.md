# VCPDeck 集成测试清单

> 文件：`scripts/test.cjs`
>
> 运行：`node scripts/test.cjs`
>
> 自动启动 Server 进程 + 连接 mock client + 启动真实 Client → 执行 49 个用例 → 清理退出。

---

## 1. 基础基础设施（4 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 1 | Server started | Server 进程在 30s 内启动并打印 `listening on` |
| 2 | GET /api/health (public) | 公开健康检查端点返回 `200 { ok: true }` |
| 3 | Login with wrong password | 错误密码返回 `401`，不泄露信息 |
| 4 | Login as admin | 正确密码返回 `200/201` + `identity.isAdmin` |

**Mock/Real:** 无（直接 HTTP）

---

## 2. 认证 & 会话（11 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 5 | GET /api/auth/me with cookie | Cookie 会话可识别当前身份 |
| 6 | Rejects unauthenticated request | 无 cookie 访问受保护端点返回 `401` |
| 7 | GET /api/clients with auth | 带 cookie 可正常返回 |
| 8 | Create CLI token | 生成 `vcp_` 前缀的 Bearer token |
| 9 | List tokens | Token 列表接口正常工作 |
| 10 | Bearer token works | Bearer token 可用于认证 |
| 11 | Revoke token | 撤销 token 返回 `200` |
| 12 | Revoked token rejected | 已撤销的 token 返回 `401` |
| 13 | Admin creates identity | 管理员可创建非 admin 身份 |
| 14 | List identities | 身份列表包含新建身份 |
| 15 | Non-admin cannot list identities | 非 admin 请求 `/api/identities` 返回 `403` |

**Mock/Real:** 无（HTTP + Cookie）

---

## 3. 身份启用/禁用（4 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 16 | Admin disables identity | `POST /api/identities/{id}/disable` 返回 `200/201` |
| 17 | Disabled identity cannot login | 被禁身份登录返回 `401` |
| 18 | Admin enables identity | `POST /api/identities/{id}/enable` 返回 `200/201` |
| 19 | Enabled identity can login again | 启用后可重新登录 `200/201` |

**Mock/Real:** 无（HTTP）

---

## 4. REST 端点（2 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 20 | GET /api/clients returns array | 返回数组，格式正确 |
| 21 | GET /api/jobs returns array | 返回数组，格式正确 |

**Mock/Real:** 无（HTTP）

---

## 5. Client 连接 & 注册（4 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 22 | Socket.IO connects to /client | 可连接到 Server 的 `/client` WebSocket 命名空间 |
| 23 | Client registers | 发送 REGISTER 事件后收到 ack |
| 24 | Client info has fields | 注册后的 Client 在 REST 查询中有 `clientId/hostname/os` |
| 25 | Client is online | REST 查询 `online=true` |

**Mock/Real:** Mock Socket.IO 连接

---

## 6. Job 生命周期（4 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 26 | POST /api/jobs creates job | 返回 `201` 带 `jobId`，状态为 `running` |
| 27 | Client receives job:dispatch | Mock client 收到 `JOB_DISPATCH` 事件 |
| 28 | Job completes | Mock client 回复 `JOB_DONE(exitCode=0)` 后状态变为 `done` |
| 29 | Job has auth audit fields | Job 记录 `createdByIdentityId/createdByName/createdVia` |

**Mock/Real:** Mock socket 模拟 dispatch 和 done

---

## 7. Job 取消（3 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 30 | Cancel request accepted | 取消请求返回 `{ status: "cancelling" }` |
| 31 | Client receives job:cancel | Mock client 收到 `JOB_CANCEL` 事件 |
| 32 | Job is cancelled | Mock client 回复 `JOB_CANCELLED` 后状态变为 `cancelled` |

**Mock/Real:** Mock socket 模拟 cancel 事件

---

## 8. 心跳（1 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 33 | Heartbeat updates lastHeartbeatAt | 发送 HEARTBEAT 后 `lastHeartbeatAt` 变化 |

**Mock/Real:** Mock socket

---

## 9. 输入校验（3 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 34 | Rejects job for unknown client | 不存在 clientId 返回 `400` + `"not found"` |
| 35 | exec invalid mixed payload | command 模式混用 `executable` 返回 `400` |
| 36 | exec invalid bad timeout | 负 timeout 返回 `400` |

**Mock/Real:** HTTP（校验发生在 Server 端，无需 Client）

---

## 10. Exec Command 模式 —— 真实 Client（3 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 37 | exec command legacy | 旧 `{command}` payload → `waitForJobUpdate` → exitCode=0 |
| 38 | exec command explicit | 显式 `{mode:"command",command}` → exitCode=0 |
| 39 | exec command cwd | 带 `cwd` 的命令 → exitCode=0 |

**Mock/Real:** 真实 Client 进程

---

## 11. Exec Script 模式 —— 真实 Client（4 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 40 | exec script node | Node `["-"]` stdin 执行 → exitCode=0 |
| 41 | exec script node unicode | Unicode/引号/反斜杠脚本 → exitCode=0 |
| 42 | exec script quotes | 多层转义字符 → exitCode=0 |
| 43 | exec script empty args/script | `args:[]` + `script:""` → exitCode=0 |

**Mock/Real:** 真实 Client 进程 — spawn(`process.execPath`, args) → stdin 写入 → `JOB_UPDATE` 校验

---

## 12. Exec 错误路径 —— 真实 Client（3 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 44 | exec spawn failed | 不存在的 executable → `status=error, errorCode=EXEC_SPAWN_FAILED` |
| 45 | exec script non-zero exit | `process.exit(42)` → `status=error, exitCode=42`（区分 exitCode≠0 与 infra 错误） |
| 46 | exec cancel | 长时间运行脚本 → cancel 请求 → `cancelled` 终态 |

**Mock/Real:** 真实 Client 进程

---

## 13. Exec 扩展参数 —— 真实 Client（1 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 47 | exec script cwd | Script 模式带 `cwd` → exitCode=0 |

**Mock/Real:** 真实 Client 进程

---

## 14. 退出 / 清理（2 项）

| # | 名称 | 验证点 |
|---|------|--------|
| 48 | Logout | POST /api/auth/logout 成功 |
| 49 | Session invalid after logout | 退出后 /api/auth/me 返回 `401` |

---

## 测试架构

```
node scripts/test.cjs
  ├── Start Server（子进程，pnpm start）
  ├── HTTP tests（auth, REST, validation）
  ├── Mock Client（Socket.IO → /client 命名空间）
  │   ├── 注册、心跳
  │   ├── Job 生命周期（手动 emit JOB_DONE）
  │   └── Job 取消（手动 emit JOB_CANCELLED）
  ├── Real Client（子进程：node dist/index.js）
  │   ├── 真实 executor：spawn / stdin / kill
  │   ├── JOB_DONE / JOB_STDERR 由 executor 自动上报
  │   └── Monitor Socket 监听 JOB_UPDATE 验证结果
  └── Cleanup：kill ports, kill processes
```

**Monitor Socket：** 复用之前建立的 mock client 连接（仍在 `/client` 命名空间中的 socket）。Real Client 执行过程中 Server 广播的 `JOB_UPDATE` 会被这个 socket 接收到，通过 `waitForJobUpdate(jobId)` Promise 等待目标 Job 进入终态。

**关键时序约束：** `JOB_UPDATE` 广播发生在 Server 的 `sendDispatch()` 内部（HTTP 响应返回给测试之前）。因此必须使用以下模式之一：

- 在 `api("POST","/api/jobs")` 之前预先设置 `waitForJobUpdate` 监听器（需要已知 jobId，不可行）
- 使用 `sleep(n)` 启发式等待（适用于不需要捕获特定事件、只需确保状态已转换的场景，如 cancel 测试）
- 不依赖 JOB_UPDATE 的中间状态广播，仅依赖终态（done/error/cancelled）

---

## 测试用例编写约定

### 新增用例步骤

1. 在对应区域添加 `async function testXxx(...)`，使用 `clientId` 参数
2. 在 `main()` 的对应区块中调用
3. 使用预置工具函数：
   - `api(method, path, opts)` — HTTP 请求（自动 Cookie 管理）
   - `apiJson(method, path, opts)` — 简化的 JSON 返回
   - `pass(name, detail)` / `fail(name, detail)` — 记录结果
   - `sleep(ms)` — 异步等待
   - `waitForJobUpdate(jobId)` — 监听真实 Client 的 Job 终态
4. 如果是真实 Client 测试，使用 `REAL_CLIENT_ID`

### 命名惯例

- Mock client 测试使用 `test-integration-${Date.now()}` 作为 clientId
- 真实 Client 测试使用 `REAL_CLIENT_ID = "exec-test-real-client"`（通过 env 指定）
- 测试名称在 `pass/fail` 的第一个参数中，建议按模块前缀（如 `exec command ...`, `exec script ...`）

### 当前未覆盖的潜在区域

| 区域 | 缺少的用例 | 原因 |
|------|-----------|------|
| Server auth | Token 过期、Session 过期 | 当前无过期配置 |
| Job | timeout 触发 | 可加短 timeout（2s）验证 `EXEC_TIMEOUT` |
| Exec script | Python/PowerShell/Bash 运行时 | 需要对应解释器安装在 CI 环境 |
| Exec script | 大脚本（接近传输上限） | 当前无应用层上限 |
| Exec script | script mode `cwd` 不存在 | 应报 `EXEC_SPAWN_FAILED` |
| Exec | command mode `cwd` 内容验证 | 当前只验证 exitCode，不验证 stdout |
| Exec | stdout/stderr 内容验证 | 当前只验证 exitCode/errorCode |
| Exec | stdin 写入失败 → `EXEC_STDIN_FAILED` | 难以构造（进程需提前关闭 stdin） |
| Exec | 并发超过 MAX_CONCURRENT_JOBS（3） | 当前排队但未独立验证排队行为 |
| Client | 重连（disconnect → reconnect） | 模拟断开再重连较复杂 |
| Client | 心跳超时断线 | 需要等 30s+ |
| File Job | `file.*` 类型 | 尚未实现 |
| REST | Job 分页、过滤 | `/api/jobs` 当前返回最近 100 条 |
| WebSocket | Frontend 命名空间（app gateway） | 当前只测了 `/client` |
