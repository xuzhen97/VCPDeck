# Jobs 分页接口

## 目标

将 `GET /api/jobs` 从固定返回最近 100 条改为分页接口，与 FRP mappings 分页模式保持一致。

## 接口

```
GET /api/jobs?clientId=...&status=...&page=1&pageSize=20
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `clientId` | string | 无 | 可选，筛选指定机器 |
| `status` | JobStatus | 无 | 可选，筛选状态 |
| `page` | number | 1 | 页码 |
| `pageSize` | number | 20（≤100） | 每页条数 |

响应：`PaginatedResult<JobInfo>`

```json
{
  "data": [...],
  "total": 126,
  "page": 1,
  "pageSize": 20,
  "totalPages": 7
}
```

## 改动面

### Server

**`job.service.ts`** — `list()` → `list(options)`：

```ts
async list(options: {
  clientId?: string;
  status?: JobStatus;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResult<JobInfo>>
```

内部：`Promise.all([findMany({ where, skip, take }), count({ where })])`

**`events.controller.ts`** — `listJobs()` 加 `@Query` 参数，手动 parseInt，对齐 FRP controller 风格。

### SDK

**`jobs.ts`** — `list()` 加 options 参数，`URLSearchParams` 拼接 query string，对齐 `createFrpApi`。

### Frontend

**`jobs-page.tsx`** — `resource.data` 由 `JobInfo[]` 变为 `PaginatedResult<JobInfo>`，取 `.data` 渲染；clientId 不再前端过滤，直接传给后端。

**`dashboard-page.tsx`** — 传 `pageSize: 5`，从 `jobs.data` 取值。

## 不改

- `GET /api/jobs/:jobId` 单条详情接口不变
- 详情抽屉仍直接使用列表返回的 `JobInfo`，不额外请求单条接口
- 不暴露 `query` / `type` 查询参数（当前无业务需求，后续按需加）
