# FRP 配置 DB 化 + 多实例 + 健康检查

> 状态：设计中 | 2026-07-29
> 基于：`2026-07-24-frp-port-mapping-design.md`
> 参考：`D:\remote-agent-gateway` 的 `frps-dashboard.service.ts`、`frp-probe.service.ts`

## 范围

- ✅ 全部 FRP 配置从环境变量迁移到 DB 表
- ✅ 支持多套 frps 实例配置（仅 REST API，不做前端界面）
- ✅ frps 健康检查：token 有效性验证 + 已注册 proxy 列表 + 端口占用汇总
- ✅ 现有 FrpMapping 流程平滑对接
- ❌ 前端配置管理界面 — 不在本次范围

---

## 1. 数据模型变更

### 1.1 新增表：FrpsInstance

```prisma
model FrpsInstance {
  id                String   @id                    // "frps_" + uuid8
  name              String                          // 实例名称，如 "生产环境"
  serverAddr        String                          // frps 连接地址
  serverPort        Int      @default(7000)         // frps bind_port
  authToken         String   @default("")           // frps token
  dashboardScheme   String   @default("http")       // "http" | "https"
  dashboardHost     String?                         // 为空时不启用 Dashboard 对账
  dashboardPort     Int      @default(7500)
  dashboardUser     String   @default("admin")
  dashboardPassword String   @default("admin")
  portRangeStart    Int      @default(20000)
  portRangeEnd      Int      @default(21000)
  isDefault         Boolean  @default(false)        // 全局唯一默认实例
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  mappings          FrpMapping[]
}
```

### 1.2 变更表：FrpMapping

```diff
model FrpMapping {
  id           String   @id
  clientId     String
  name         String
  proxyType    String   @default("tcp")
  localIp      String   @default("127.0.0.1")
  localPort    Int
  remotePort   Int?
  customDomain String?
  status       String   @default("inactive")
  publicUrl    String?
+ frpsInstanceId String?                            // NULL = 使用默认实例
+ frpsInstance   FrpsInstance? @relation(fields: [frpsInstanceId], references: [id])
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  client       Client   @relation(fields: [clientId], references: [id])
}
```

---

## 2. 新增 REST API

### 2.1 FrpsInstance CRUD

全部挂在 `/api/frp/instances`：

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/frp/instances` | 创建实例；若 `isDefault=true` 则取消其他实例的默认标记 |
| `GET` | `/api/frp/instances` | 分页列表（复用 PaginatedResult） |
| `GET` | `/api/frp/instances/:id` | 获取单个实例 |
| `PUT` | `/api/frp/instances/:id` | 更新配置；isDefault 冲突处理同上 |
| `DELETE` | `/api/frp/instances/:id` | 删除实例；若有 FrpMapping 关联则拒绝（返回 409） |
| `POST` | `/api/frp/instances/:id/probe` | 健康检查 |
| `POST` | `/api/frp/instances/:id/set-default` | 单独设为默认（RPC 风格，语义比 PUT 更明确） |

### 2.2 健康检查端点

`POST /api/frp/instances/:id/probe`（无请求体）

逻辑流程：

```
1. 从 DB 读取实例配置
2. TCP 连接 serverAddr:serverPort → 记录 tcpReachable + latencyMs
3. 如果有 dashboardHost → 调 Dashboard API /api/serverinfo 验证 auth
   - 200: authValid=true
   - 401/403: authValid=false, 返回错误信息
   - 不可达: dashboardReachable=false
4. authValid=true 时，并行拉取 /api/proxy/tcp|http|https → 汇总端口占用
5. 返回 ProbeResult
```

### 2.3 ProbeResult 结构

```ts
interface ProbeResult {
  ok: boolean;                    // token 有效且 Dashboard 可达
  tcpReachable: boolean;
  tcpLatencyMs: number;
  dashboardReachable: boolean;
  authValid: boolean;             // token 有效性
  serverInfo?: {                  // Dashboard 可达时返回
    version: string;
  };
  error?: string;
  proxies: {
    total: number;
    byType: { tcp: number; http: number; https: number };
    list: { name: string; proxyType: string; remotePort: number | null }[];
    usedPorts: number[];           // 已占用端口号，去重排序
  } | null;                        // Dashboard 不可达时为 null
}
```

---

## 3. 现有流程变更

### 3.1 配置加载

```
原有：getFrpConfig() 读环境变量 → 返回 FrpConfig 单例
变更：FrpService 构造时从 DB 加载 isDefault 实例
      → 缓存为实例配置（类似 StorageService 的 loadProvider 模式）
      → reload() 方法供 PUT 端点更新后热刷新
```

### 3.2 FrpService.createMapping() 变更点

```diff
- const config = getFrpConfig();
- const remotePort = await this.allocator.allocate({ preferredPort });
- const frpsInfo = { serverAddr: config.frpsPublicHost, serverPort: ..., authToken: ... };

+ const instance = dto.frpsInstanceId
+   ? await this.getInstance(dto.frpsInstanceId)
+   : this.getDefaultInstance();
+ const remotePort = await this.allocator.allocate({
+     preferredPort: dto.remotePort,
+     portRangeStart: instance.portRangeStart,
+     portRangeEnd: instance.portRangeEnd,
+     dashboard: instance.dashboardHost ? { ... } : null,
+   });
+ const frpsInfo = { serverAddr: instance.serverAddr, serverPort: instance.serverPort, authToken: instance.authToken };
+ mapping.frpsInstanceId = instance.id;
```

### 3.3 PortAllocator 变更

```
原有：constructor(prisma)，端口范围从 getFrpConfig() 读取
变更：allocate() 接收 portRangeStart/portRangeEnd/dashboard 参数
      → 不再依赖全局 getFrpConfig()
      → 支持不同实例有不同端口范围
```

### 3.4 FrpMappingCreateRequest 变更

```diff
export interface FrpMappingCreateRequest {
  clientId: string;
  name: string;
  proxyType: "tcp" | "http" | "https";
  localIp: string;
  localPort: number;
  remotePort?: number;
  customDomain?: string;
+ frpsInstanceId?: string;   // 可选，不传则用默认实例
}
```

### 3.5 SDK 变更

```diff
export function createFrpApi(client) {
  return {
    // ...现有四个方法不变...
+   instances: {
+     list, get, create, update, delete, probe, setDefault,
+   },
  };
}
```

---

## 4. 环境变量迁移策略

### 4.1 启动自动迁移

Server 首次启动时（DB 中无任何 FrpsInstance 记录），从旧环境变量自动创建一条默认记录：

| DB 字段 | 源环境变量 | 默认值 |
|---------|-----------|--------|
| serverAddr | `FRP_PUBLIC_HOST` | `"127.0.0.1"` |
| serverPort | `FRPS_BIND_PORT` | `7000` |
| authToken | `FRPS_TOKEN` | `""` |
| dashboardHost | `FRP_DASHBOARD_HOST` | — |
| dashboardScheme | `FRP_DASHBOARD_SCHEME` | `"http"` |
| dashboardPort | `FRP_DASHBOARD_PORT` | `7500` |
| dashboardUser | `FRP_DASHBOARD_USER` | `"admin"` |
| dashboardPassword | `FRP_DASHBOARD_PASSWORD` | `"admin"` |
| portRangeStart | `FRP_PORT_RANGE_START` | `20000` |
| portRangeEnd | `FRP_PORT_RANGE_END` | `21000` |

迁移后环境变量不再被读取。可在启动日志中打一条："已从环境变量迁移 FRP 配置到 DB"。

### 4.2 `frp-config.ts` 处理

原 `getFrpConfig()` 在迁移完成后不再被调用。保留文件但标记为 deprecated，后续版本移除。

---

## 5. 模块结构

```
packages/server/src/frp/
  frp.module.ts              # 不变
  frp.controller.ts          # 新增 /instances 路由
  frp.service.ts             # 加实例管理方法 + 缓存 + 变更对接
  frp-instances.controller.ts  # 新建：FrpsInstance CRUD 端点
  frp-instances.service.ts     # 新建：FrpsInstance CRUD + 迁移 + probe
  port-allocator.ts          # allocate() 参数扩展
  frp-config.ts              # 标记 deprecated

packages/shared/src/index.ts
  # 新增类型：FrpsInstanceInfo, FrpsInstanceCreateRequest, FrpsInstanceUpdateRequest, ProbeResult

packages/sdk/src/frp.ts
  # 新增 sdk.frp.instances.*
```

---

## 6. 已知约束

- **删除保护**：有 FrpMapping 关联的实例不允许删除（409 Conflict）
- **isDefault 唯一性**：DB 层不做唯一约束（SQLite 不支持 partial unique index），由 Service 层保证
- **热刷新**：更新/创建实例后，如果影响默认实例配置则立即刷新缓存
- **Probe 无副作用**：健康检查端点不写 DB，纯只读
- **无前端**：不做配置管理 UI，但 FrpPanel 创建映射表单需增加 frpsInstance 选择框（如果有多实例）

---

## 7. 测试要点

- 首次启动自动迁移（有/无旧环境变量两种场景）
- 创建映射未指定实例 → 走默认实例
- 创建映射指定实例 → 走对应实例的端口范围
- 删除有映射关联的实例 → 409
- 健康检查：token 有效 / token 无效 / Dashboard 不可达 / 无 Dashboard
- PortAllocator 不同实例跑在不同端口范围
- isDefault 切换后新映射指向正确默认实例
