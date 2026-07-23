# Server ↔ Client 核心交互 — 人工验收指南

> 基于 `docs/server-client-interaction-design.md` 及实现计划 `docs/superpowers/plans/2026-07-23-server-client-core.md`

## 前提

两个终端窗口，都在项目根目录 `D:\VCPHub\VCPDeck`。

---

## 1. 启动 Server

终端 1：

```bash
cd packages/server && node dist/main.js
```

预期输出：

```
[Nest] ... [NestApplication] Nest application successfully started
VCPDeck server listening on http://localhost:3001
```

---

## 2. 启动 Client

终端 2：

```bash
cd packages/client && node -e "
const { connect } = require('./dist/index.js');
const socket = connect();
"
```

预期输出：

```
[vcpdeck] connected as <UUID>
```

---

## 3. 验收 REST 端点

### 3a. 列出已注册的 client

```bash
curl http://localhost:3001/api/clients
```

预期：返回数组，包含刚连接的 client 信息（clientId, hostname, os, capabilities 等）。

### 3b. 创建一个 Job

```bash
curl -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"clientId":"<步骤3a返回的clientId>","command":"echo hello world"}'
```

预期：返回 `{"jobId":"...","status":"running"}`。

### 3c. 查看 Job 列表

```bash
curl http://localhost:3001/api/jobs
```

预期：返回所有 job，刚创建的 job 状态为 `running` 或 `done`。

---

## 4. 验收 Job 执行

执行步骤 3b 后，client 终端（终端 2）应显示：

```
[vcpdeck] job dispatch: <jobId> — echo hello world
```

client 会 spawn 子进程执行命令，stdout/stderr 通过 Socket.IO 流式回传 server，server 广播给 frontend。

---

## 5. 验收 Job 取消

### 5a. 创建长时间运行的 Job

```bash
curl -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"clientId":"<clientId>","command":"sleep 60"}'
```

记下返回的 `jobId`。

### 5b. 发送取消请求

```bash
curl -X POST http://localhost:3001/api/jobs/<jobId>/cancel
```

预期：

- 返回 `{"jobId":"...","status":"cancelling"}`
- client 端收到 `job:cancel` 事件，显示 `[vcpdeck] job cancel: <jobId>`
- client 发送 `SIGTERM`，5s 后若进程仍在则发送 `SIGKILL`
- client 发送 `job:cancelled` 确认

---

## 6. 验收断线重连

- 关闭终端 2（client 断线）
- server 终端 1 显示 `[ws] disconnected`
- 重新启动 client（终端 2）
- client 重连后自动发送 `register` + `status:report`
- server 恢复 running job 状态

---

## 验收清单

| 功能 | 操作 | 预期结果 |
|---|---|---|
| 服务启动 | `node dist/main.js` | NestJS 正常启动 |
| 客户端连接 | 启动 client | `[vcpdeck] connected` |
| 注册 | client 自动 | server 日志 `[ws] registered` |
| 心跳 | client 自动每 30s | server 收到 heartbeat |
| 列出 clients | `GET /api/clients` | 数组，含在线 client |
| 创建 job | `POST /api/jobs` | `{ jobId, status }` |
| 列出 jobs | `GET /api/jobs` | job 列表 |
| Job 执行 | 创建 job 后 | client 执行并流式回传输出 |
| Job 取消 | `POST /api/jobs/:id/cancel` | SIGTERM → SIGKILL → 确认 |

## 边界

- Client 与 Server 在同一台机器验证，暂不涉及跨网络
- 文件操作（FileRef）和 FRP 隧道不在本次验收范围内
