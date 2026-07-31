# 存储页面体验优化设计

- 日期：2026-07-31
- 状态：已确认，待编写实现计划
- 范围：Frontend 存储页面、Storage 配置安全返回、SDK Storage API

## 1. 背景与目标

当前存储页面把阿里云盘状态、Storage 后端切换、阿里云盘配置和 OAuth 表单同时平铺展示，用户难以第一眼判断当前实际生效的存储后端，也不容易理解切换动作、配置动作和授权动作之间的关系。

本次优化目标：

1. 页面打开后，用户无需阅读按钮或进入表单即可知道当前激活的 Storage 后端。
2. 用明确的切换控件支持本地存储与阿里云盘之间的切换。
3. 用 Tab 收纳后端配置、阿里云盘设置、授权与安全，降低首屏信息密度。
4. 切换过程提供确认、loading、成功和失败反馈，且页面最终以服务端状态为准。
5. 不向浏览器返回或展示 Storage 配置 JSON 中的密钥和 OAuth token。
6. 只使用现有后端能力，不增加文件迁移或虚假的健康检查能力。

## 2. 现有后端事实与约束

当前后端的真实流程如下：

- `StorageBackendConfig.kind` 是激活后端的持久化事实来源。
- 未配置时 `StorageService.loadProvider()` 默认使用 `local`。
- `PUT /api/storage/config` 接收 `kind`，写入数据库并调用 `StorageService.reload()` 热加载 provider。
- 当前注册后端为 `local` 和 `alibaba`。
- `GET /api/aliyundrive/status` 返回不含原始 secret/token 的阿里云盘状态摘要。
- `PUT /api/aliyundrive/config` 保存 Client ID、可选 Client Secret、OpenAPI 地址和传输目录；保存结果不返回 Client Secret。
- OAuth 由 `/api/aliyundrive/oauth/start`、`/complete`、`/revoke` 驱动。
- 切换后端不会迁移历史文件，后端没有迁移接口。
- 后端允许将 `kind` 切换为 `alibaba`，但切换接口本身不校验阿里云盘是否已授权；因此前端不能把“未授权”误报成“切换失败”或擅自阻止切换。

### 2.1 必须保留的安全边界

当前 `GET /api/storage/config` 返回 `{ kind, config, updatedAt }`，其中 `config` 可能包含：

- `clientSecret`
- `accessToken`
- `refreshToken`

本次实现将修改该读取接口的公开结果，只返回：

```ts
{
  kind: "local" | "alibaba";
  updatedAt: string | null;
}
```

不增加原始配置读取接口，不在前端缓存 secret 或 token，也不通过表单回填 Client Secret。

## 3. 页面信息架构

页面从上到下分为三层。

### 3.1 顶部激活区

顶部状态卡是页面的主视觉焦点，包含：

- 标题“当前激活的存储”
- 当前后端名称：本地存储 / 阿里云盘
- 状态点和文字状态
- 当前后端的简短说明
- 本地存储 / 阿里云盘快捷切换控件
- “切换只影响新任务，不会自动迁移已有文件”的说明

状态文案以两个服务端结果组合生成：

| Storage `kind` | 阿里云盘状态 | 页面状态 |
|---|---|---|
| `local` | 任意 | 本地存储 · 正常运行 |
| `alibaba` | `authorized` | 阿里云盘 · 已授权 |
| `alibaba` | 未授权 | 阿里云盘 · 尚未授权 |
| `alibaba` | `isExpired` | 阿里云盘 · 授权已过期 |

阿里云盘未授权或已过期时显示警示状态，并明确提示新的文件操作可能失败；不能把 `kind: alibaba` 改写为本地存储，也不能仅凭授权状态推断后端切换失败。

### 3.2 Tab 配置区

Tab 使用单面板展示内容，固定包含三项：

#### 后端配置

- 展示本地存储和阿里云盘两个后端卡片。
- 显示当前后端及“当前使用”标识。
- 提供完整切换入口；顶部快捷切换和卡片入口共用同一个切换处理函数。
- 本地存储只展示说明，不添加后端不存在的路径或容量配置表单。
- 阿里云盘卡片展示配置/授权摘要，并提供进入对应 Tab 的入口。
- 说明切换不迁移历史文件。

#### 阿里云盘设置

- Client ID：必填。
- Client Secret：密码输入框，提交时可为空表示保留原值；保存成功后清空输入框，绝不回填。
- 传输目录：使用现有字段，默认值沿用服务端返回/现有页面默认值。
- 保存调用 `PUT /api/aliyundrive/config`。
- 保存成功后刷新阿里云盘安全状态。

#### 授权与安全

- 展示 `configured`、`authorized`、`isExpired`、Client ID、Drive ID、过期时间等现有安全摘要。
- “开始授权”调用 `POST /api/aliyundrive/oauth/start`。
- 仅在授权地址通过现有安全校验后打开新窗口。
- 提供 OAuth State 和授权码输入，完成授权调用 `POST /api/aliyundrive/oauth/complete`。
- 撤销授权调用 `POST /api/aliyundrive/oauth/revoke`，继续使用确认对话框。
- 授权、完成授权和撤销后刷新状态；不读取原始 token。

### 3.3 全局反馈

- 页面加载时并行读取 Storage 后端摘要和阿里云盘状态。
- 切换请求期间锁定两个切换入口，设置 `aria-busy`，保留现有内容，避免页面闪白。
- 切换成功后重新读取两个状态，再显示成功 Toast。
- 切换失败时保留服务端确认的旧状态，显示错误信息和重试动作。
- 页面刷新后始终从服务端重新加载，不使用 `localStorage` 恢复激活状态。

## 4. 数据流与接口

### 4.1 页面加载

```text
StoragePage
  ├─ GET /api/storage/config
  │    └─ { kind, updatedAt }
  └─ GET /api/aliyundrive/status
       └─ safe status summary
```

两者可并行请求；任一请求失败时，页面使用现有错误态并提供重试，不伪造状态。

### 4.2 切换后端

```text
用户点击阿里云盘
  → 确认对话框
  → PUT /api/storage/config { kind: "alibaba" }
  → StorageService.updateBackendConfig()
  → upsert StorageBackendConfig.kind
  → StorageService.reload()
  → 重新 GET storage/config + aliyundrive/status
  → 更新顶部状态、Tab 卡片和 Toast
```

切回本地存储时不显示二次确认，但仍执行 loading、服务端请求和状态刷新。顶部快捷入口与 Tab 内入口不得分别维护激活状态。

### 4.3 SDK 变化

在 `packages/sdk/src/storage.ts` 中增加读取安全摘要的方法，名称和现有 SDK 风格保持一致，例如：

```ts
getBackendConfig(signal?) =>
  client.request<{ kind: "local" | "alibaba"; updatedAt: string | null }>(
    "GET",
    "/api/storage/config",
    undefined,
    signal,
  )
```

现有 `setBackend` 保留，并将其响应类型收窄为安全摘要。具体命名以现有 SDK 约定为准，不新增独立的状态缓存层。

## 5. 交互与动画规范

动画只表达状态变化，不做装饰性动效：

- Tab 切换：160ms 淡入。
- 顶部状态更新：180ms 轻微淡入/位移。
- 切换请求中：切换控件进入 loading，禁止重复点击，保留原内容。
- 切换到阿里云盘前：淡入遮罩和确认弹窗，说明新任务使用云盘、历史文件不迁移、未完成任务继续使用原后端。
- 切换成功：服务端状态刷新完成后显示绿色“存储后端已切换” Toast，约 2.5 秒后自动消失。
- 切换失败：保留旧状态，显示错误提示和重试入口。
- `prefers-reduced-motion: reduce` 时关闭位移、渐变和进度动画，只保留文字/颜色状态变化。

不能在请求开始时直接把顶部状态永久改成目标后端；切换中的临时文案可以显示“正在切换”，但最终状态必须来自刷新后的服务端响应。

## 6. 错误处理

| 场景 | 页面行为 |
|---|---|
| Storage 状态加载失败 | 显示错误态和重试，不渲染未知激活后端 |
| 阿里云盘状态加载失败 | 保留 Storage `kind`，授权状态显示不可用，并提供重试 |
| 切换请求失败 | 关闭 loading，保留旧状态，显示错误和重试 |
| 切换到未授权的阿里云盘 | 切换成功后显示“已设为当前后端，但尚未授权，新的文件操作可能失败” |
| 保存配置时缺少 Client ID | 显示服务端错误，不清空已输入内容 |
| OAuth 开始时未配置 Client ID | 显示“请先完成阿里云盘设置”，不打开窗口 |
| OAuth 地址不安全 | 不打开窗口，保留“授权地址不安全”错误 |
| OAuth 会话过期 | 提示重新开始授权，保留可继续操作的页面状态 |
| 撤销授权 | 继续使用确认弹窗；成功后刷新摘要，失败时保留授权状态 |

所有错误信息应使用现有 SDK/API 错误处理方式，不展示 stack、密钥、token 或服务端原始配置 JSON。

## 7. 可访问性与响应式

- Tab 使用语义化 tablist/tab/tabpanel，当前项设置 `aria-selected`。
- 切换控件在请求期间设置 `aria-busy` 并禁用。
- 状态更新区域使用 `aria-live="polite"`，同时提供文字状态，不只依靠颜色。
- 确认弹窗可用键盘关闭、确认和取消。
- 桌面端状态卡横向排列；窄屏下状态信息和切换控件纵向排列，切换控件可占满宽度。
- 保持现有深色/浅色主题变量和页面组件，不引入新的 UI 依赖。

## 8. 测试与验收

### 8.1 SDK/服务端

- `GET /api/storage/config` 只返回 `kind` 和 `updatedAt`，不包含 `config`。
- 未配置数据库记录时返回 `kind: "local"`。
- `PUT /api/storage/config` 仍能切换 `local` / `alibaba`，并触发 provider reload。
- Storage SDK 能读取安全摘要并发送切换请求。
- 现有阿里云盘配置和 OAuth 行为保持不变。

### 8.2 前端

- 初始渲染显示服务端返回的当前后端。
- 顶部快捷入口和 Tab 内入口调用同一个切换逻辑。
- 本地 → 阿里云盘需要确认；取消不会发送请求。
- 阿里云盘 → 本地不需要确认，但显示 loading。
- 切换完成后重新加载状态；不依赖乐观更新。
- 切换失败后原状态可见，并提供重试。
- 阿里云盘未授权/过期时显示对应警示文案。
- Client Secret 保存后清空，页面不显示原始 secret/token。
- OAuth 不安全 URL 不会调用 `window.open`。
- Tab 切换和撤销授权不破坏现有 OAuth 测试。

### 8.3 验收标准

1. 用户进入页面后 3 秒内能识别当前激活后端。
2. 用户不需要打开配置 Tab 就能完成后端切换。
3. 用户能明确区分“当前后端”“阿里云盘已授权”和“阿里云盘已配置”。
4. 任何切换结果都与服务端最终响应一致。
5. 浏览器网络响应中不出现 `clientSecret`、`accessToken`、`refreshToken` 或完整 `config`。
6. 既有本地文件、云盘文件和 OAuth 流程不因页面重排而增加迁移或删除行为。

## 9. 非目标

本次不实现：

- 文件在本地与阿里云盘之间的迁移。
- 存储容量、空间使用量和后端健康检查接口。
- 多存储后端同时启用。
- 前端 localStorage 状态缓存。
- 新的配置抽象、状态管理框架或 UI 依赖。
- 阿里云盘 OAuth 自动回调页面；继续使用现有手动 state/code 流程。
