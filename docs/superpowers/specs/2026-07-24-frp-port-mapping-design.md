# FRP 端口映射模块设计

> 状态：设计中 | 2026-07-24
> 参考：`D:\remote-agent-gateway` 的 FRP 模块实现
> 前置依赖：Server ↔ Client 核心交互已实现（2026-07-23-server-client-core-design.md）

## 范围

- ✅ FRP 映射 CRUD（REST API + WebSocket Job）
- ✅ Server 端口分配 + 冲突检测（DB + 可选 frps Dashboard）
- ✅ Client frpc 守护进程管理（可选能力，按 capabilities 启用）
- ✅ frpc 二进制分发（打包内置 + 下载脚本）
- ✅ frpc 多平台支持（Windows / Linux amd64 & arm64）
- ✅ 断线/删除时映射状态管理
- ❌ frps 内置管理 — 用户自建 frps

---

## 1. 数据模型

### Prisma 新增表

```prisma
model FrpMapping {
  id           String   @id                          // "fm_" + uuid8
  clientId     String
  name         String                                 // 映射名称，对应 frpc proxy name
  proxyType    String   @default("tcp")               // "tcp" | "http" | "https"
  localIp      String   @default("127.0.0.1")
  localPort    Int
  remotePort   Int?                                   // Server 分配后填入，唯一
  customDomain String?
  status       String   @default("inactive")          // inactive | active | error
  publicUrl    String?                                // 外部可访问地址
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  client       Client   @relation(fields: [clientId], references: [id])
}
```

### Server 配置新增

```yaml
# server.config.yaml
frp:
  portRangeStart: 20000
  portRangeEnd: 21000
  frpsPublicHost: "frp.example.com"      # frps 公网地址，用于拼 publicUrl
  frpsDashboard:                          # 可选：frps Dashboard 对账
    scheme: "http"
    host: "127.0.0.1"
    port: 7500
    user: "admin"
    password: "admin"
```

### publicUrl 生成规则

| proxyType | publicUrl |
|-----------|-----------|
| tcp | `<frpsPublicHost>:<remotePort>` |
| http | `http://<frpsPublicHost>:<remotePort>` 或 `http://<customDomain>` |
| https | `https://<customDomain>`（必须有 customDomain） |

---

## 2. 端口分配

### 分配流程

```
POST /api/frp/mappings
  → 检查 client 在线 + capabilities 含 "frp"
  → 端口分配：
     1. 查 DB 已用的 remotePort（FrpMapping.remotePort WHERE NOT NULL）
     2. 如果配了 frpsDashboard：查 Dashboard 已用端口（30s 缓存）
        - Dashboard 可达 → 合并去重
        - Dashboard 不可达 → 告警日志 + 仅 DB 检查，不阻塞
     3. 从 portRangeStart..portRangeEnd 取第一个空闲端口
     4. 串行化锁防竞态（异步队列）
  → INSERT FrpMapping（status=inactive）
  → 下发 FRP_CREATE Job 到 Client
  → 返回映射详情（不等 Job 完成）
```

### 并发安全

分配操作通过异步队列串行化（`Promise` 链），确保同范围端口分配不冲突。不引入额外锁依赖。

---

## 3. Job 协议

### 新增 JobType（`@vcpdeck/shared`）

```typescript
JobType.FRP_CREATE = "frp.create"
JobType.FRP_DELETE = "frp.delete"
JobType.FRP_LIST   = "frp.list"
```

### frp.create（Server → Client）

```typescript
interface FrpCreatePayload {
  mappingId: string;
  name: string;
  proxyType: "tcp" | "http" | "https";
  localIp: string;
  localPort: number;
  remotePort: number;
  customDomain?: string;
  frpsInfo: {
    serverAddr: string;      // frps 地址
    serverPort: number;      // frps bindPort
    authToken: string;       // frps token
  };
}
```

### frp.delete（Server → Client）

```typescript
interface FrpDeletePayload {
  mappingId: string;
  name: string;              // 用于 frpc 配置匹配
}
```

### frp.list（Server → Client）

无 payload。Client 返回当前生效的映射 ID 列表。

### Client 响应

```typescript
// 成功
{ jobId, type: "frp.create", result: { mappingId, status: "active" } }
{ jobId, type: "frp.delete", result: { mappingId, deleted: true } }
{ jobId, type: "frp.list",   result: { mappings: [{ id, name, proxyType, localPort, remotePort, status }] } }

// 失败
{ jobId, type: "frp.create", error: { code: "FRPC_START_FAILED", message: "..." } }
```

### 状态更新

Server 收到 `JOB_DONE` → 更新 `FrpMapping.status`（active / error）。

---

## 4. Client frpc 守护进程

### 能力声明

Client 在 `MachineRegister.capabilities` 中声明 `"frp"`。Server 下发 FRP Job 前检查该能力，无此能力返回 `"FRP not enabled on this client"`。

### 启动流程

```
Client 启动
  → 读配置 frpcPath（默认 dist/frp/<platform>/frpc[.exe]）
  → 如果 capabilities 不含 "frp" → 跳过，frp 能力不初始化
  → 如果含 "frp"：
      - 检测 frpc 二进制是否存在
      - 不存在 → console.warn，frp 能力待机（后续也可通过手动放置后下发 FRP_LIST 触发检测）
      - 存在 → 就绪，等 Server 下发第一个 FRP 映射时启动 frpc
```

### 进程管理

- **单进程 + 合并配置**：所有映射合并为一个 `frpc-combined.toml`，一个 frpc 进程处理所有代理
- **热重建**：增删映射 → 停止当前 frpc → 重写配置文件 → 启动新 frpc
- **无映射时停止**：删除最后一个映射后 kill frpc，不保持空进程
- **PID 文件**（`frpc-daemon.pid`）：启动前检查并清理旧 PID
- **异常处理**：frpc 崩溃不打日志告警，不自动重启；所有关联映射标记为 error

### 配置文件结构

```toml
# frpc-combined.toml
serverAddr = "frp.example.com"
serverPort = 7000

auth.method = "token"
auth.token = "xxx"

[[proxies]]
name = "my-webapp"
type = "http"
localIP = "127.0.0.1"
localPort = 3000
customDomains = ["webapp.example.com"]

[[proxies]]
name = "my-ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 20001
```

### 客户端配置新增

```yaml
# client.config.yaml
frpcPath: ""          # 可选，覆盖默认路径
frpcWorkDir: ""       # 可选，frpc 配置和数据目录（默认 client 二进制所在目录下的 frp 子目录）
```

### 平台映射

| process.platform | process.arch | 默认路径 |
|---|---|---|
| win32 | x64 | `dist/frp/win-x64/frpc.exe` |
| linux | x64 | `dist/frp/linux-x64/frpc` |
| linux | arm64 | `dist/frp/linux-arm64/frpc` |

---

## 5. Server 模块结构

```
packages/server/src/frp/
  frp.module.ts
  frp.service.ts          # 映射 CRUD + 端口分配 + 对账逻辑
  frp.controller.ts       # REST API
  port-allocator.ts       # 端口分配器（DB + 可选 Dashboard 双重检查）
```

### FrpService

| 方法 | 说明 |
|---|---|
| `createMapping(dto)` | 端口分配 → INSERT → 下发 Job → 返回映射 |
| `getMapping(id)` | 查询单条 |
| `listMappings(clientId?)` | 列表查询 |
| `deleteMapping(id)` | 检查 → 下发 Job → DELETE → 释放端口 |
| `updateStatus(id, status)` | 接收 Job 回调更新状态 |
| `markInactiveByClient(clientId)` | Client 断线时批量标记 inactive |
| `cleanupStaleDashboardProxies()` | 启动时对账 Dashboard（如配置了） |

### FrpController

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/frp/mappings` | 创建映射 |
| `GET` | `/api/frp/mappings` | 列出（支持 `?clientId=`） |
| `GET` | `/api/frp/mappings/:id` | 单个详情 |
| `DELETE` | `/api/frp/mappings/:id` | 删除映射 |

---

## 6. 下载脚本

`scripts/download-frp.ts`，通过 `pnpm download:frp` 调用。

做的事：

- 读 `FRP_VERSION`（默认 latest，通过 GitHub API 解析）
- 检测当前平台 → 映射到 frp release asset：
  - Windows x64 → `frp_<ver>_windows_amd64.zip`
  - Linux x64 → `frp_<ver>_linux_amd64.tar.gz`
  - Linux arm64 → `frp_<ver>_linux_arm64.tar.gz`
- 下载 → 解压 → 提取 `frpc[.exe]` → 放入：
  - `packages/client/dist/frp/<platform>/frpc[.exe]`
- 可选：放入 `packages/server/dist/frp/` 方便本地调试

多平台打包时，可手动指定 `--platform win-x64 --platform linux-x64 --platform linux-arm64` 批量下载。

---

## 7. 状态与断线处理

| 事件 | 操作 |
|---|---|
| 创建映射 | status=inactive，等待 Client JOB_DONE → active |
| Client JOB_DONE 成功 | status=active |
| Client JOB_DONE 失败 | status=error，记录 errorMessage |
| 删除映射 | 下发 Job → 删除 DB 记录 → 释放端口 |
| Client 断线 | 该 Client 所有映射标记为 inactive（端口不释放） |
| Client 重连 | 下发 FRP_LIST 对账。Server 为权威源：DB 有但 Client 无 → 重新下发 FRP_CREATE；Client 有但 DB 无 → 下发 FRP_DELETE 令其清理 |
| Server 启动 | 可选对账 Dashboard 清理 stale proxy |

---

## 8. 预留给后续的设计

- frpc 自动更新/自愈
- 映射健康探测（TCP/HTTP probe）
- 流量统计
- 批量映射下发

---

## 9. 决策记录

| 决策 | 结论 |
|---|---|
| frps 部署 | 用户自建，不内置 frps 管理 |
| frpc 分发 | 打包内置 + `pnpm download:frp` 脚本，非运行时下载 |
| 架构模式 | 纯 WebSocket Job 系统，不引入 Client HTTP 控制面 |
| 端口冲突 | DB 必查 + Dashboard 可选查（不可达时降级） |
| frpc 能力 | 可选，通过 capabilities 声明 |
| 映射粒度 | 单次创建/删除，逐个操作 |
| 端口范围 | 用户配置 `portRangeStart` ~ `portRangeEnd` |
