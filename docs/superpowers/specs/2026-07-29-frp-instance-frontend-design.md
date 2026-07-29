# FRP 多实例前端管理与映射对接设计

> 状态：已确认 | 2026-07-29  
> API 依据：`docs/2026-07-29-frp-instance-api-reference.md`

## 1. 目标与范围

在现有 FRP 前端中接入 `sdk.frp.instances`，让所有登录用户能够管理多套 frps 实例，并在创建映射时选择目标实例。

本次范围：

- FRP 页增加“映射”和“实例配置”两个页内标签。
- 实例列表、创建、编辑、删除、设为默认和主动健康检查。
- 创建映射时选择 frps 实例并提交 `frpsInstanceId`。
- 展示实例端口范围和健康检查返回的代理、占用端口信息。
- 为新增交互补充前端测试。

不在范围：

- 不新增路由、全局状态层或第三方依赖。
- 不持久化健康检查结果。
- 不自动健康检查、不自动推荐端口。
- 不改变后端 API、SDK 协议或权限模型。

## 2. 页面结构

`/frp` 保持单一路由，由 `FrpPage` 提供页内导航：

- **映射**：默认标签，继续渲染现有 `FrpPanel`。
- **实例配置**：渲染新增的 `FrpsInstancesPanel`。

所有登录用户都能查看并操作两个标签。标签切换使用页面本地状态，不引入子路由；刷新页面后回到“映射”。

`FrpPanel` 保留映射列表、创建、轮询和删除职责。`FrpsInstancesPanel` 独立负责实例加载、分页、CRUD、默认切换与 Probe。实例表单先作为实例面板的内部组件实现，不建立通用表单抽象。

## 3. 实例配置面板

### 3.1 列表

实例列表调用：

```ts
sdk.frp.instances.list({ page, pageSize: 20 }, signal)
```

每项显示：

- 名称及“默认”标签；
- `serverAddr:serverPort`；
- 端口范围；
- 当前页面会话中的健康状态；
- “设为默认”“健康检查”“编辑”“删除”操作。

默认实例不显示“设为默认”。列表沿用项目现有上一页、下一页分页样式。健康状态初始为“未检查”，刷新后恢复为该状态。

### 3.2 新增与编辑

新增和编辑复用一个 Drawer，表单分为：

1. 基础连接：名称、Server 地址、Server 端口、Auth Token；
2. Dashboard：Scheme、Host、端口、用户名、密码；
3. 端口范围：起始端口、结束端口；
4. 默认实例开关仅在新增时提供；已有实例使用列表中的“设为默认”操作，避免两个入口表达同一动作。

创建调用 `sdk.frp.instances.create()`，编辑调用 `sdk.frp.instances.update()`。操作成功后关闭 Drawer 并重新加载服务端列表。

`authToken` 和 `dashboardPassword` 使用密码输入框，默认掩码并提供独立的显示/隐藏按钮。编辑时以详情 API 返回值初始化并原样保留；用户改动后提交新值。

Dashboard Host 留空时：

- 创建请求不传 `dashboardHost`；
- 更新请求传 `dashboardHost: null`，明确关闭 Dashboard 对账。

表单使用浏览器原生约束：

- `name`、`serverAddr` 必填；
- 所有端口限制为 `1–65535`；
- `portRangeStart <= portRangeEnd`，不满足时阻止提交并显示字段附近错误；
- Dashboard Scheme 仅允许 `http` 或 `https`。

### 3.3 设置默认与删除

“设为默认”调用：

```ts
sdk.frp.instances.setDefault(instance.id)
```

成功后重新加载列表，以服务端返回状态为准，不在前端维护第二份默认关系。

删除复用现有 `ConfirmTargetDialog`，要求输入实例名称确认。删除调用 `sdk.frp.instances.delete()`。若后端因关联映射拒绝删除，确认上下文保持打开并显示 SDK 提供的安全错误信息。

### 3.4 健康检查

健康检查仅由用户点击触发：

```ts
sdk.frp.instances.probe(instance.id, signal)
```

结果保存在面板本地的 `Record<string, ProbeResult>`，不写数据库。检查中只禁用对应实例的 Probe 按钮。

结果展示：

- `tcpReachable` 与 `tcpLatencyMs`；
- `dashboardReachable` 与 `authValid`；
- `serverInfo.version`（存在时）；
- Proxy 总数和 TCP、HTTP、HTTPS 数量；
- `proxies.usedPorts`（存在时）。

状态文案按失败层次区分：TCP 不可达、Dashboard 不可达、Dashboard 认证无效。没有 Dashboard 且 TCP 可达时显示“TCP 可达，未配置 Dashboard”，不把 `authValid: false` 误报为认证失败。

## 4. 创建映射对接

打开创建映射 Drawer 时加载最多 100 个实例：

```ts
sdk.frp.instances.list({ page: 1, pageSize: 100 }, signal)
```

表单增加“frps 实例”下拉框：

- 选项显示实例名称；默认实例附加“默认”标签；
- 初始选择 `isDefault === true` 的实例；没有默认实例时保持未选择；
- 选择后在字段下方显示该实例的 `serverAddr:serverPort` 和端口范围；
- 不自动 Probe，不显示缓存于另一个标签中的 Probe 结果，不推荐端口。

提交时仅在用户选中实例后加入：

```ts
{ frpsInstanceId: selectedInstanceId }
```

未选中时不传该字段，由后端使用默认实例或返回权威错误。实例列表加载失败时，映射表单仍允许按“不传实例”的兼容路径提交，同时在下拉框附近提示无法加载实例列表。

现有远程端口字段保持可选。前端只按 `1–65535` 校验；是否位于所选实例端口范围、是否已占用由后端最终判断。

当前 `FrpMappingInfo` 不包含 `frpsInstanceId`，因此映射列表本次不展示关联实例，避免为每条映射额外推断或请求数据。

## 5. 数据流与状态

- `FrpPage`：仅维护当前标签。
- `FrpPanel`：继续用 `useResource` 加载映射；创建 Drawer 单独维护实例列表状态。
- `FrpsInstancesPanel`：用 `useResource` 加载实例分页列表；本地维护 Drawer、操作中实例、Probe 结果和操作错误。
- 创建、编辑、删除、设默认成功后统一调用 `resource.reload()`。
- 组件卸载或同类请求被新请求替代时通过 `AbortController` 取消请求；不建立额外请求管理层。

## 6. 错误与空状态

- 主列表加载复用 `LoadingState` 和 `ErrorState`。
- 无实例时显示说明及“新增实例”入口。
- 表单、Probe、设默认和删除错误显示在对应操作区域，并保持用户已输入内容。
- SDK 抛出的安全 message 可以展示；不展示 stack、响应原文、Token 或密码。
- Probe 失败不影响实例列表，也不覆盖上一次成功结果之外的其他实例状态。

## 7. 文件边界

计划涉及：

- `packages/frontend/src/pages/frp-page.tsx`：页内标签和面板切换；
- `packages/frontend/src/pages/frp-panel.tsx`：创建映射时加载并选择实例；
- `packages/frontend/src/pages/frps-instances-panel.tsx`：实例管理与 Probe；
- `packages/frontend/src/pages/frp-page.test.tsx`：扩展映射实例选择测试；
- `packages/frontend/src/pages/frps-instances-panel.test.tsx`：实例管理测试；
- 必要时对 `packages/frontend/src/styles.css` 做最小样式补充，优先复用已有类和 UI 组件。

不拆分额外 hooks、context、API wrapper 或通用 form 组件。

## 8. 测试与验收

最低自动化测试：

1. 标签切换显示正确面板；
2. 实例列表显示默认标签，设置默认后重新加载；
3. 新增与编辑请求正确提交字段；更新时空 Dashboard Host 发送 `null`；
4. Token 与密码默认掩码且可切换显示；
5. Probe 正确呈现成功、无 Dashboard、认证失败三类结果；
6. 删除要求实例名称确认，后端拒绝错误可见；
7. 创建映射默认选中默认实例，并将 `frpsInstanceId` 传给 SDK；
8. 实例加载失败时仍可按后端默认实例路径创建；
9. 原有映射轮询和删除行为不回归。

完成前运行：

```bash
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/frontend build
```

并通过 LSP 与项目诊断确认修改文件无阻塞错误。
