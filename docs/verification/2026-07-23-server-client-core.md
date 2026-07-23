# Server ↔ Client 核心交互 — 人工验收指南

> 基于 `docs/server-client-interaction-design.md` 及实现计划 `docs/superpowers/plans/2026-07-23-server-client-core.md`

## 启动 Server 和 Client

### 1. 启动 Server

终端 1：

```bash
cd packages/server && pnpm start
```

预期输出：

```
Your database is now in sync with your Prisma schema.
[Nest] ... Nest application successfully started
VCPDeck server listening on http://localhost:3001
```

### 2. 启动 Client

终端 2：

```bash
cd packages/client && pnpm start
```

预期输出：

```
[vcpdeck] connected as <UUID>
```

---

## 3. 验收 REST 端点

以下所有命令在 PowerShell / CMD / Git Bash 中通用（使用 Node.js 内置 `fetch`）。

### 3a. 列出已注册的 client

```bash
node -e "fetch('http://localhost:3001/api/clients').then(r=>r.json()).then(console.log)"
```

预期：返回数组，包含刚连接的 client 信息（clientId, hostname, os, capabilities 等）。

### 3b. 创建一个 Job

用 `<clientId>` 替换步骤 3a 返回的 `clientId`：

```bash
node -e "fetch('http://localhost:3001/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:'<clientId>',command:'echo hello world'})}).then(r=>r.json()).then(console.log)"
```

预期：返回 `{ jobId: "...", status: "running" }`。

### 3c. 查看 Job 列表

```bash
node -e "fetch('http://localhost:3001/api/jobs').then(r=>r.json()).then(console.log)"
```

预期：返回所有 job，刚创建的 job 状态为 `running` 或 `done`。

---

## 4. 验收 Job 执行

执行步骤 3b 后，client 终端（启动 client 的那一个）应显示：

```
[client] [vcpdeck] job dispatch: <jobId> — echo hello world
```

client 会 spawn 子进程执行命令，stdout 流式回传 server。

---

## 5. 验收 Job 取消

### 5a. 创建长时间运行的 Job

```bash
node -e "fetch('http://localhost:3001/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:'<clientId>',command:'sleep 60'})}).then(r=>r.json()).then(console.log)"
```

记下返回的 `jobId`。

### 5b. 发送取消请求

```bash
node -e "fetch('http://localhost:3001/api/jobs/<jobId>/cancel',{method:'POST'}).then(r=>r.json()).then(console.log)"
```

预期：

- 返回 `{ jobId: "...", status: "cancelling" }`
- client 端收到 `job:cancel` 事件，显示 `[vcpdeck] job cancel: <jobId>`
- client 发送 `SIGTERM`，5s 后若进程仍在则发送 `SIGKILL`
- client 发送 `job:cancelled` 确认

---

## 6. 验收断线重连

- `Ctrl+C` 停止 client（client 断线）
- server 日志显示 `[ws] disconnected`
- 重新启动 client：在新终端执行 `pnpm start`（或在原终端重新跑）
- client 重连后自动发送 `register` + `status:report`
- server 恢复 running job 状态

---

## 验收清单

| 功能 | 操作 | 预期结果 |
|---|---|---|
| 服务启动 | `cd packages/server && pnpm start` | NestJS 正常启动 |
| 注册 | client 自动 | server 日志 `[ws] registered: xxx (hostname)` |
| 心跳 | client 自动每 30s | server 无报错 |
| 列出 clients | `node -e "fetch(.../api/clients)"` | 数组，含 hostname/os/capabilities |
| 创建 job | `node -e "fetch(...POST /api/jobs)"` | `{ jobId, status }` |
| 列出 jobs | `node -e "fetch(.../api/jobs)"` | job 列表 |
| Job 执行 | 创建 job 后 | client 执行并流式回传输出 |
| Job 取消 | `node -e "fetch(...POST /api/jobs/:id/cancel)"` | SIGTERM → SIGKILL → 确认 |
| 断线重连 | 停止 client → 重启 | server 恢复 job 状态 |

## 边界

- Client 与 Server 在同一台机器验证，暂不涉及跨网络
- 文件操作（FileRef）和 FRP 隧道不在本次验收范围内
