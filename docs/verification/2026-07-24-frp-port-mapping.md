# FRP 端口映射模块 — 人工验收指南

> 基于 `docs/superpowers/specs/2026-07-24-frp-port-mapping-design.md`
> 实现计划 `docs/superpowers/plans/2026-07-24-frp-port-mapping.md`

## 前置准备

### 1. frp 二进制

测试用 frps + frpc 已在 `D:/remote-agent-gateway/bin/` 下，复制到预期位置：

```bash
mkdir -p packages/client/dist/frp/win-x64
mkdir -p packages/server/dist/frp/win-x64

cp D:/remote-agent-gateway/bin/frpc.exe packages/client/dist/frp/win-x64/
cp D:/remote-agent-gateway/bin/frps.exe packages/server/dist/frp/win-x64/
```

正式环境运行 `pnpm download:frp` 自动下载（需要 GitHub 网络）。

### 2. 配置 frps

在 frps 所在机器新建 `frps.toml`：

```toml
bindPort = 7000

auth.method = "token"
auth.token = "your-strong-token"

webServer.addr = "0.0.0.0"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "your-dashboard-password"

allowPorts = [{ start = 20000, end = 21000 }]
vhostHTTPPort = 8080

log.to = "./frps.log"
log.level = "info"
log.maxDays = 7
```

启动：

```bash
./frps -c frps.toml
```

### 3. 配置 Server 环境变量

`packages/server/.env` 追加：

```env
FRP_PORT_RANGE_START=20000
FRP_PORT_RANGE_END=21000
FRP_PUBLIC_HOST=<frps 的公网 IP 或域名>
FRPS_BIND_PORT=7000
FRPS_TOKEN=your-strong-token
FRP_DASHBOARD_HOST=127.0.0.1
FRP_DASHBOARD_PORT=7500
FRP_DASHBOARD_USER=admin
FRP_DASHBOARD_PASSWORD=your-dashboard-password
```

---

## 启动服务

### 终端 1：Server

```bash
cd packages/server && pnpm start
```

预期：`[NestApplication] Nest application successfully started`

### 终端 2：Client（带 frp 能力）

```bash
cd packages/client && pnpm start
```

预期日志：

```
[vcpdeck] connected as <UUID>
```

---

## 验收流程

### 1. 确认 Client 已注册 frp 能力

```bash
node -e "fetch('http://localhost:3001/api/clients').then(r=>r.json()).then(c=>console.log(JSON.stringify(c[0],null,2)))"
```

预期 `capabilities` 包含 `"frp"`。

---

### 2. 创建 TCP 端口映射

用上一步返回的 `clientId` 替换 `<clientId>`：

```bash
node -e "
fetch('http://localhost:3001/api/frp/mappings',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    clientId:'<clientId>',
    name:'my-tcp-service',
    proxyType:'tcp',
    localPort:3306
  })
}).then(r=>r.json()).then(console.log)
"
```

预期返回：

```json
{
  "id": "fm_xxxxxxxx",
  "clientId": "<clientId>",
  "name": "my-tcp-service",
  "proxyType": "tcp",
  "localIp": "127.0.0.1",
  "localPort": 3306,
  "remotePort": 20000,
  "publicUrl": "<frpsPublicHost>:20000",
  "status": "inactive",
  ...
}
```

等待几秒后 status 变为 `active`：

```bash
node -e "fetch('http://localhost:3001/api/frp/mappings/fm_xxxxxxxx').then(r=>r.json()).then(console.log)"
```

---

### 3. 创建 HTTP 映射（带自定义域名）

```bash
node -e "
fetch('http://localhost:3001/api/frp/mappings',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    clientId:'<clientId>',
    name:'my-webapp',
    proxyType:'http',
    localPort:3000,
    customDomain:'webapp.example.com'
  })
}).then(r=>r.json()).then(console.log)
"
```

预期 `publicUrl` 为 `http://webapp.example.com`。

---

### 4. 列出所有映射

```bash
node -e "fetch('http://localhost:3001/api/frp/mappings').then(r=>r.json()).then(console.log)"
```

或按 client 筛选：

```bash
node -e "fetch('http://localhost:3001/api/frp/mappings?clientId=<clientId>').then(r=>r.json()).then(console.log)"
```

---

### 5. 查看单个映射

```bash
node -e "fetch('http://localhost:3001/api/frp/mappings/<mappingId>').then(r=>r.json()).then(console.log)"
```

---

### 6. 在 frps Dashboard 确认

浏览器打开 `http://<frps_host>:7500`，用户 `admin`，查看 **Proxies** 页面：

- `my-tcp-service` → type=tcp, remotePort=20000, status=online
- `my-webapp` → type=http, customDomains=[webapp.example.com], status=online

---

### 7. 删除映射

```bash
node -e "fetch('http://localhost:3001/api/frp/mappings/<mappingId>',{method:'DELETE'}).then(r=>r.json()).then(console.log)"
```

预期：`{ "id": "...", "deleted": true }`

再次 GET 该 ID 应返回 400；frps Dashboard 上该代理消失或变为 offline。

---

### 8. Client 断线后映射状态

1. `Ctrl+C` 停止 Client
2. 查看映射状态：

```bash
node -e "fetch('http://localhost:3001/api/frp/mappings/<mappingId>').then(r=>r.json()).then(console.log)"
```

预期 `status` 变为 `inactive`（端口不释放）。

1. 重新启动 Client — 映射应恢复为 `active`。

---

## 自动化集成测试

```bash
pnpm test:frp
```

测试覆盖：

```
=== VCPDeck FRP Integration Test ===

  ✓ frps binary
  ✓ frpc binary
  ✓ frps started
  ✓ Server started
  ✓ Client registered with frp
  ✓ POST create tcp mapping
  ✓ Mapping becomes active
  ✓ frps Dashboard: proxy test-tcp registered
  ✓ POST create http mapping
  ✓ Mapping becomes active
  ✓ frps Dashboard: proxy test-http registered
  ✓ GET list mappings
  ✓ GET single mapping
  ✓ DELETE mapping
  ✓ DELETE mapping: verify gone
  ✓ frps Dashboard: proxy test-http offline
  ✓ No-frp-capability rejection
  ✓ Invalid proxyType rejection
  ✓ Missing required fields rejection
  ✓ Cleanup complete

  20/20 passed, 0 failed, 0 skipped
```

---

## 验收清单

| 功能 | 操作 | 预期结果 |
|---|---|---|
| Client frp 能力 | Client 启动，frpc 二进制就位 | `capabilities` 含 `"frp"` |
| 创建 TCP 映射 | `POST /api/frp/mappings` tcp | 返回 `publicUrl: "host:port"`, 状态最终 active |
| 创建 HTTP 映射 | `POST /api/frp/mappings` http + customDomain | 返回 `publicUrl: "http://domain"` |
| 端口分配 | 连续创建 3 个映射 | remotePort 递增，不重复 |
| 列出映射 | `GET /api/frp/mappings` | 返回数组 |
| 按 client 筛选 | `GET /api/frp/mappings?clientId=` | 只返回该 client 的映射 |
| 单个详情 | `GET /api/frp/mappings/:id` | 完整字段 |
| frps Dashboard 注册 | 创建后浏览器/API 查看 | 代理出现在 Dashboard |
| 删除映射 | `DELETE /api/frp/mappings/:id` | `deleted: true` |
| 删除后确认 | 二次 GET | 400 |
| 删除后 Dashboard | 查看 Dashboard | 代理消失/offline |
| 无 frp 能力拒绝 | 用无 frp 能力的 client 创建 | 400 + 明确错误 |
| 无效 proxyType | type=udp | 400 |
| 必填字段校验 | 缺 localPort | 400 |
| Client 断线 | 停止 Client | 映射 status → inactive |
| Client 重连 | 重启 Client | 映射恢复 active |

---

## 实现总结

### 文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/shared/src/index.ts` | 修改 | FRP JobType、payload/result 接口 |
| `packages/server/prisma/schema.prisma` | 修改 | FrpMapping 表 + Client 关联 |
| `packages/server/src/frp/frp-config.ts` | 新建 | 环境变量配置 |
| `packages/server/src/frp/port-allocator.ts` | 新建 | 端口分配（DB + Dashboard 双重检查） |
| `packages/server/src/frp/frp.service.ts` | 新建 | CRUD + publicUrl + Job 下发 |
| `packages/server/src/frp/frp.controller.ts` | 新建 | REST API（4 个端点） |
| `packages/server/src/frp/frp.module.ts` | 新建 | NestJS 模块注册 |
| `packages/server/src/app.module.ts` | 修改 | 注册 FrpModule |
| `packages/server/src/events/events.module.ts` | 修改 | 导入 FrpModule + 导出 ClientGateway |
| `packages/server/src/events/client.gateway.ts` | 修改 | FRP Job 回调 + 断线标记 inactive |
| `packages/client/src/frpc-daemon.ts` | 新建 | frpc 守护进程（单进程+合并配置+热重建） |
| `packages/client/src/dispatcher.ts` | 修改 | 路由 frp.* Job |
| `packages/client/src/register.ts` | 修改 | 条件声明 "frp" 能力 |
| `scripts/download-frp.ts` | 新建 | 下载 frpc + frps 多平台二进制 |
| `scripts/test-frp.cjs` | 新建 | 20 条集成测试 |

### 已知限制

- Windows 上 `SIGTERM` 不能优雅关闭 frpc，删除映射后 frps Dashboard 显示 offline 而非立即消失
- HTTP 类型映射需要 `customDomain` 才能在 frps 上注册
- frps Dashboard 检查为可选功能（不可达时降级警告）
- 重连对账 FRP 映射暂未实现（后续通过 `frp.list` Job 对账）
- 非 frp 能力 client 的 frpc-daemon 模块会在首次 frp Job 时按需加载
