# FRP 管理界面视觉优化设计

> 状态：已确认 | 2026-07-30  
> 基于：`docs/superpowers/specs/2026-07-29-frp-instance-frontend-design.md`

## 1. 目标与范围

优化 FRP 的“映射”和“实例配置”两个 Tab，使信息密度、扫描效率、响应式表现和操作层级符合管理控制台使用习惯，同时保持现有浅色玻璃主题和 API 行为。

本次范围：

- 映射列表改为桌面管理表格和移动端紧凑卡片。
- Client 列显示 `hostname`，短 `clientId` 作为辅助信息。
- 映射行增加“复制公网地址 / 删除映射”更多菜单。
- 实例配置列表改为桌面管理表格和移动端紧凑卡片。
- 实例行整合默认状态、端口池、Dashboard 和健康信息。
- Probe 结果在对应实例行下方展开。
- 映射与实例 Drawer 改为响应式宽版分组表单。
- 统一两个 Tab 的标题、说明、表头、标签、菜单、分页和空状态视觉。

不在范围：

- 不改变 REST、SDK 或共享类型。
- 不增加 Client 自定义别名；Client 名称使用现有 `hostname`。
- 不增加全局 Toast、表格库、Dropdown 依赖或新的全局状态。
- 不改变创建、编辑、删除、Probe、设置默认和校验语义。
- 不持久化 Probe 结果或菜单状态。

## 2. 视觉方向

采用紧凑的管理表格，而不是大面积资源卡或统计仪表盘：

- 表格容器保持圆角、细边框和轻阴影，减少现有卡片内部空白。
- 表头使用低对比背景、小号字和适度字距，增强列扫描。
- 主信息使用正常正文权重；ID 和辅助信息使用小号、低对比、等宽字体。
- 状态采用轻量语义标签：绿色健康/运行中，黄色待处理，红色异常，紫色默认。
- 端点、Server 地址、实例 ID 使用等宽字体。
- 删除等危险操作不常驻为高饱和按钮，收进更多菜单，但继续使用二次确认。
- 单页不显示无效分页按钮；多页时在表格下方显示统计与分页。

## 3. 映射管理表格

### 3.1 数据加载

`FrpPanel` 同时加载：

```ts
sdk.frp.list({ clientId, page, pageSize: 20 }, signal)
sdk.clients.list(signal)
```

映射请求是页面核心数据；Client 请求只是名称增强：

- 映射加载失败时继续显示页面级 `ErrorState`。
- Client 加载失败时映射仍正常展示，Client 名称降级为“未知 Client”。
- Client 列以 `clientId → hostname` 映射查找名称，不逐行请求。
- 在机器工作区传入 `clientId` 时也保持相同行为，不改变 `FrpPanel` props。

### 3.2 桌面列

`md` 及以上显示管理表格：

| 列 | 内容 |
|---|---|
| 映射 | 映射名称 |
| Client | `hostname` 为主，截断 `clientId` 为辅助 |
| 类型 | TCP / HTTP / HTTPS 轻量标签 |
| 状态 | 中文语义状态标签 |
| 本地端点 | `localIp:localPort` |
| 公网端点 | `publicUrl`；未分配时显示低对比占位 |
| 操作 | 更多菜单按钮 |

短 ID 采用稳定前缀，例如 `${clientId.slice(0, 8)}…`；找不到 Client 时仍显示短 ID，避免丢失定位信息。

### 3.3 更多菜单

映射菜单包含：

- **复制公网地址**：仅 `publicUrl` 存在时可用，调用 `navigator.clipboard.writeText(publicUrl)`；成功后当前行短暂显示“已复制”，失败显示“复制失败”。
- **删除映射**：打开现有 `ConfirmTargetDialog`，继续要求输入完整映射名称。

实现一个 FRP 页面内部复用的小型菜单组件，供映射和实例使用。组件负责按钮、定位、键盘 Escape 和点击外部关闭；不建立全局 Dropdown 抽象，不新增依赖。

### 3.4 移动端

`md` 以下不显示桌面表头，每条映射变为紧凑卡片行：

- 第一行：名称、状态、更多菜单；
- 第二行：Client hostname、类型；
- 第三行：本地端点 → 公网端点；
- 短 Client ID 仅在空间允许或名称缺失时显示。

移动端不依赖横向滚动完成主要操作。

## 4. 实例配置管理表格

### 4.1 桌面列

| 列 | 内容 |
|---|---|
| 实例 | 名称、默认标签、短实例 ID |
| Server | `serverAddr:serverPort` |
| 端口池 | `portRangeStart–portRangeEnd` 和端口总数 |
| Dashboard | HTTP / HTTPS；未配置时显示“未配置” |
| 健康状态 | 未检查、检查中、健康或分层失败状态 |
| 操作 | 更多菜单按钮 |

端口数量使用闭区间计算：

```ts
portRangeEnd - portRangeStart + 1
```

健康状态在已 Probe 后补充延迟、Proxy 总数和 FRP 版本；不存在的数据不显示占位噪声。

### 4.2 实例更多菜单

菜单包含：

- 健康检查；
- 编辑配置；
- 设为默认（默认实例隐藏）；
- 删除实例。

菜单只改变入口形态，继续复用现有操作函数、错误处理和删除确认。

### 4.3 Probe 展开区

成功或失败的 Probe 结果显示在对应实例行下方：

- TCP 可达性和延迟；
- Dashboard 可达性和认证状态；
- Proxy 总数及 TCP / HTTP / HTTPS 分类；
- FRP 版本；
- 已占用端口。

展开区使用左侧语义色边框和结构化信息网格。没有 Dashboard 时显示“TCP 可达，未配置 Dashboard”，不误报认证失败。Probe 结果继续只保存在当前组件会话。

### 4.4 移动端

实例行转换为紧凑卡片：

- 第一行：实例名称、默认/健康标签、更多菜单；
- 主体：Server、端口池、Dashboard；
- Probe 详情在卡片下方单列展开。

## 5. Tab、标题与分页

- `FrpPage` 保留本地 Tab 状态和现有路由。
- Tab 使用清晰的激活底线或胶囊状态，避免当前按钮与正文层级相近。
- 映射区标题使用“公网映射”，说明为“管理 Client 服务与公网入口”。
- 实例区标题使用“frps 实例”，说明为“管理连接配置、端口池与服务健康状态”。
- `totalPages <= 1` 时只显示总数，不显示上一页/下一页。
- `totalPages > 1` 时显示页码和分页按钮。
- 空状态在表格容器中居中展示一句说明和主操作入口，不保留大面积空白。

## 6. Drawer 与表单

### 6.1 Drawer

为现有 `Drawer` 增加可选宽度属性，例如：

```ts
size?: "default" | "wide"
```

- 默认值保持现有宽度，其他页面不受影响。
- FRP 创建映射、创建实例、编辑实例使用 `wide`。
- 桌面宽度约 `720px`；移动端 `max-w-[95vw]`。
- 保留遮罩、Escape 关闭和滚动行为。

### 6.2 映射表单

桌面两列、移动单列，并按职责分组：

- **目标**：Client、frps 实例、映射名称；
- **本地服务**：代理类型、本地 IP、本地端口；
- **公网入口**：公网端口、自定义域名。

区块标题跨两列。状态、实例加载错误和提交错误显示在表单底部操作区。字段、默认值、校验和请求体保持不变。

### 6.3 实例表单

分组为：

- **基础连接**：实例名称、Server 地址、Server 端口、Auth Token；
- **Dashboard**：Scheme、Host、端口、用户名、密码；
- **端口范围**：起始、结束；
- **默认设置**：仅创建时显示。

Token 与密码继续默认掩码并可独立显示。清空 Dashboard Host 更新时继续提交 `null`。端口保持 `1–65535` 和起始不大于结束的校验。

## 7. 错误处理与安全

- Client 名称增强失败不阻断映射主列表。
- Clipboard 失败只在当前映射行反馈，不引入全局通知系统。
- 更多菜单关闭不清除已有表单或 Probe 状态。
- 删除仍经过目标名称确认。
- 不在列表、菜单、Probe 或错误文案中显示 Auth Token、Dashboard 密码、stack 或原始响应。
- API 错误继续显示 SDK 提供的安全 message。

## 8. 文件边界

预计涉及：

- `packages/frontend/src/pages/frp-page.tsx`：Tab 视觉；
- `packages/frontend/src/pages/frp-panel.tsx`：Client 名称加载、映射表格、移动卡片、菜单和宽表单；
- `packages/frontend/src/pages/frps-instances-panel.tsx`：实例表格、移动卡片、菜单、Probe 展开和宽表单；
- `packages/frontend/src/components/ui/drawer.tsx`：可选宽度；
- FRP 对应测试文件；
- `packages/frontend/src/styles.css`：仅在 Tailwind 类不足以清晰表达共享表格样式时做最小补充。

不新增表格库、Dropdown 库、全局 Context 或通用数据表格系统。

实施前必须复核并保留上述目标文件中用户已有的未提交改动，不能用整文件覆盖。

## 9. 测试与验收

最低自动化测试：

1. Client hostname 根据 `clientId` 正确展示，短 ID 保留；
2. Client API 失败时映射列表仍展示并降级为未知 Client；
3. 映射表格含名称、Client、类型、状态、本地端点和公网端点；
4. 复制公网地址调用 Clipboard API，失败反馈可见；
5. 映射更多菜单仍能打开删除确认；
6. 单页隐藏分页按钮，多页显示；
7. 实例表格显示默认、Server、端口数量、Dashboard 和健康状态；
8. 实例菜单触发 Probe、编辑、设默认和删除；
9. Probe 后展开结构化详情；
10. 宽 Drawer 与两列表单保留原有提交、验证和秘密字段掩码行为；
11. 现有映射轮询、创建、删除和实例 CRUD 测试不回归。

完成前运行：

```bash
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/frontend build
```

并通过 LSP、pi-lens 和浏览器桌面/窄屏检查确认无阻塞错误、溢出或不可达操作。
