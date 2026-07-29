# FRP 实例配置管理 API 参考

> 2026-07-29  
> 前端消费参考文档

新增 FRP 实例配置管理功能，将 FRP 配置从环境变量迁移到 DB，支持多 frps 实例 + 健康检查。

---

## 概述

原有 FRP 配置全部依赖环境变量（`FRP_PUBLIC_HOST`、`FRPS_TOKEN` 等），现在改为存储在 `FrpsInstance` 表中，通过 REST API 管理。

**概念：**

| 概念 | 说明 |
|------|------|
| **FrpsInstance** | 一套完整的 frps 配置，包括连接地址、token、Dashboard 认证、端口范围 |
| **默认实例** | 当全局只有一个 frps 时设为默认，创建映射不传 `frpsInstanceId` 时自动使用 |
| **Probe** | 健康检查，验证 frps 可达性 + token 有效性 + 拉取已注册 proxy 列表 |

---

## 完整 API 清单

### 1. FrpsInstance CRUD

#### `POST /api/frp/instances` — 创建实例

```json
// Request
{
  "name": "生产 frps",
  "serverAddr": "1.2.3.4",
  "serverPort": 7000,
  "authToken": "my-token",
  "dashboardScheme": "http",
  "dashboardHost": "1.2.3.4",
  "dashboardPort": 7500,
  "dashboardUser": "admin",
  "dashboardPassword": "change-me",
  "portRangeStart": 20000,
  "portRangeEnd": 21000,
  "isDefault": true
}
```

必填：`name`、`serverAddr`；其余为可选，上述代码为默认值。

```json
// Response 201
{
  "id": "frps_a1b2c3d4",
  "name": "生产 frps",
  "serverAddr": "1.2.3.4",
  "serverPort": 7000,
  "authToken": "my-token",
  "dashboardScheme": "http",
  "dashboardHost": "1.2.3.4",
  "dashboardPort": 7500,
  "dashboardUser": "admin",
  "dashboardPassword": "change-me",
  "portRangeStart": 20000,
  "portRangeEnd": 21000,
  "isDefault": true,
  "createdAt": "2026-07-29T...",
  "updatedAt": "2026-07-29T..."
}
```

若 `isDefault=true`，其他实例的 `isDefault` 自动设为 `false`。

---

#### `GET /api/frp/instances` — 实例列表

参数：`?page=1&pageSize=20`

```json
// Response 200
{
  "data": [ /* FrpsInstanceInfo[] */ ],
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "totalPages": 1
}
```

---

#### `GET /api/frp/instances/:id` — 实例详情

```json
// Response 200
{ /* FrpsInstanceInfo */ }
```

---

#### `PUT /api/frp/instances/:id` — 更新实例

所有字段可选，只传需要变更的字段。

```json
// Request（部分更新）
{
  "name": "新名称",
  "authToken": "new-token"
}
```

```json
// Response 200
{ /* FrpsInstanceInfo */ }
```

**注意：** `dashboardHost` 设为 `null` 可关闭 Dashboard 对账。

---

#### `DELETE /api/frp/instances/:id` — 删除实例

```json
// Response 200
{ "id": "frps_xxx", "deleted": true }
```

**删除保护：** 若有 `FrpMapping` 关联到此实例，返回 `400 Bad Request` 并提示关联的映射数量。

---

### 2. 健康检查

#### `POST /api/frp/instances/:id/probe` — 健康检查

无请求体。

```json
// Response 200 — Dashboard 可达且 token 有效
{
  "ok": true,
  "tcpReachable": true,
  "tcpLatencyMs": 12,
  "dashboardReachable": true,
  "authValid": true,
  "serverInfo": { "version": "0.61.0" },
  "proxies": {
    "total": 5,
    "byType": { "tcp": 3, "http": 1, "https": 1 },
    "list": [
      { "name": "web-app", "proxyType": "tcp", "remotePort": 20001 },
      { "name": "api", "proxyType": "http", "remotePort": 20002 }
    ],
    "usedPorts": [20001, 20002, 20005, 20008, 20011]
  }
}
```

**各场景返回值：**

| 场景 | `ok` | `authValid` | `proxies` |
|------|------|-------------|-----------|
| 有 Dashboard，token 有效 | `true` | `true` | proxy 列表 |
| 有 Dashboard，token 无效 | `false` | `false` | `null` |
| 有 Dashboard，但不可达 | `false` | `false` | `null`（`dashboardReachable: false`） |
| 无 Dashboard，TCP 可达 | `true` | `false` | `null` |
| 无 Dashboard，TCP 不可达 | `false` | `false` | `null` |

---

### 3. 设置默认实例

#### `POST /api/frp/instances/:id/set-default` — 设为默认

无请求体。清除所有其他实例的 `isDefault` 标记，将指定实例设为默认。

```json
// Response 200
{ /* FrpsInstanceInfo（isDefault: true） */ }
```

---

### 4. 已有映射接口变更

#### `POST /api/frp/mappings` — 创建映射

新增可选字段 `frpsInstanceId`：

```json
// Request
{
  "clientId": "client-uuid",
  "name": "web-app",
  "proxyType": "tcp",
  "localIp": "127.0.0.1",
  "localPort": 3000,
  "remotePort": 20001,
  "frpsInstanceId": "frps_a1b2c3d4"   // 新增，可选
}
```

- **不传** `frpsInstanceId` → 使用当前默认实例
- **传** → 使用指定实例的端口范围和 frps 连接信息
- 无效实例 ID → 400

---

## SDK 用法

```ts
import { createClient } from "@vcpdeck/sdk";

const client = createClient({ baseUrl: "http://localhost:3001" });

// ── FrpsInstance 管理 ──

// 列表
const list = await client.frp.instances.list({ page: 1 });

// 详情
const instance = await client.frp.instances.get("frps_xxx");

// 创建
const created = await client.frp.instances.create({
  name: "生产 frps",
  serverAddr: "1.2.3.4",
  serverPort: 7000,
  authToken: "xxx",
  dashboardHost: "1.2.3.4",
  isDefault: true,
});

// 更新
await client.frp.instances.update("frps_xxx", { name: "新名称" });

// 删除
await client.frp.instances.delete("frps_xxx");

// 健康检查
const probe = await client.frp.instances.probe("frps_xxx");
console.log(probe.ok, probe.proxies?.usedPorts);

// 设为默认
await client.frp.instances.setDefault("frps_xxx");

// ── 已有的映射接口（新增 frpsInstanceId 参数）──

// 创建映射（指定实例）
const mapping = await client.frp.create({
  clientId: "client-1",
  name: "my-app",
  proxyType: "tcp",
  localPort: 3000,
  frpsInstanceId: "frps_xxx",  // 可选
});
```

---

## 启动行为

Server 初次启动时（DB 中无 `FrpsInstance` 记录），自动从旧环境变量迁移一条默认实例：

```
[FrpsInstancesService] 已从环境变量迁移 FRP 配置到 DB
```

迁移后仍可通过 API 新增、编辑实例。旧环境变量不再生效。

---

## 前端改造点

原有 `FrpPanel` 创建映射表单不需要强制改动——`frpsInstanceId` 为可选字段，不传时走默认实例。

如果前端需要支持多实例，只需在创建映射的抽屉表单中增加一个下拉框：

- 加载：`GET /api/frp/instances` → 列表
- 选中：传 `frpsInstanceId` 到创建请求
- 显示默认标记：`isDefault: true` 的实例后面加星标或"默认"标签

健康检查结果中的 `proxies.usedPorts` 可用于前端端口分配预览（新建映射时提示哪些端口已被占用）。

---

## 错误码

| 状态码 | 场景 |
|--------|------|
| 400 | 必填字段缺失、实例不存在、删除有映射关联的实例 |
| 401 | 未登录（所有端点需认证） |
