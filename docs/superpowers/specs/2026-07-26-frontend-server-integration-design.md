# VCPDeck Frontend 与 Server 对接设计

> 状态：已确认
> 日期：2026-07-26
> 范围：Frontend、最小 `@vcpdeck/sdk` 与现有 Server API 的对接
> 视觉参考：`D:/noesis/packages/web`
> 接口事实来源：`docs/integration-guide.md` 与当前代码实现

## 1. 目标

将当前 VCPDeck Frontend 从认证页面骨架升级为完整远程操作控制台，对接 Server 已实现的认证、在线 Client、Job、命令与脚本、远程文件、FRP、Storage、阿里云盘、Token 和身份管理能力。

设计目标：

- 延续 Noesis 的成熟控制台视觉和交互模式；
- 以机器为核心工作上下文，减少跨页面切换；
- 使用 REST 轮询，不依赖当前未闭环的 App WebSocket；
- 不展示 Server 无法提供的数据，不使用大规模 mock 数据；
- 将框架无关的 API 调用沉淀为最小 `@vcpdeck/sdk`，供后续 CLI、Skill 和第三方集成复用；
- 明确当前权限、数据隔离、敏感信息和危险操作边界。

本次不实现 CLI 或 Skill，不修改 Server 业务能力，不实现实时 stdout/stderr、本地上传后 import、`agent.run` 或 FRP Client 删除确认。

## 2. 已确认的设计方向

- 控制台采用 **操作优先** 信息架构；
- 机器详情是核心工作区；
- 机器工作区使用标签页：`概览｜执行｜文件｜FRP｜任务记录`；
- 执行结果使用诚实状态摘要，不放不可工作的终端输出区；
- Storage/阿里云盘使用保守接入，不读取原始 Storage config；
- 危险操作采用分级确认；
- 文件页使用三栏资源管理器；
- 视觉和组件基础采用 Noesis 同类方案：Tailwind CSS、Lucide、按需 Radix/shadcn 风格基础组件；
- 新增最小 `@vcpdeck/sdk`，Frontend 只通过 SDK 对接 Server。

## 3. 现状与能力边界

### 3.1 当前 Frontend

当前 Frontend 已有：

- Cookie 登录和认证上下文；
- 个人身份读取；
- CLI Token 创建、列表、撤销；
- admin 身份创建、禁用和启用；
- 极简 Dashboard 和路由。

尚未对接在线 Client、Job、命令/脚本、文件、Storage、阿里云盘和 FRP。

### 3.2 当前 Server 约束

设计必须保留以下真实边界：

1. 任意已认证身份都可以调用远程 shell、文件、Storage、阿里云盘和 FRP；admin 只额外拥有身份管理能力；
2. Job 查询不按身份隔离，最近 100 条 Job 对所有已认证身份可见；
3. stdout/stderr 未持久化，`/app` namespace 尚未接收 Client Job 事件；
4. `GET /api/clients` 只返回在线 Client；
5. Job 列表固定最近 100 条，无分页和 Server 筛选；
6. 非 exec Job 取消不可靠；
7. Storage 原始 config 和部分阿里云盘配置响应可能包含凭证；
8. 本地上传 Storage 后缺少取得 Prisma `fileId` 的公开闭环，因此不能完成通用本地上传后 import；
9. FRP 删除只证明 Server 映射记录已删除，不能证明 Client frpc 已清理；
10. `agent.run` 未实现；
11. 文件 symlink 逃逸检查仍会吞掉自身的 `PATH_NOT_ALLOWED`，文件能力只面向可信操作者。

### 3.3 `file.roots` 契约

当前已实现：

```json
POST /api/jobs
{
  "clientId": "<clientId>",
  "type": "file.roots",
  "payload": {}
}
```

完成结果：

```json
{
  "status": "done",
  "result": {
    "roots": ["C:\\", "D:\\"]
  }
}
```

- Windows 探测并返回 Client 进程可访问的盘符；
- Linux/macOS 优先返回 `/`，无法读取时回退 home；
- `file.roots` 要求 `file.read` capability；
- Linux `/` 前缀判断和大小写敏感路径已修复；
- Frontend 不猜测盘符，也不在浏览器中维护手写 root 列表。

## 4. 前端基础与视觉系统

### 4.1 技术选择

保留 React、Vite 和 React Router，引入：

- Tailwind CSS；
- Lucide React 图标；
- 仅当前页面需要的 Radix/shadcn 风格组件：Button、Card、Input、Label、Dialog、Tabs、Table、Select、Dropdown、Toast；
- `clsx`、`tailwind-merge` 和 `class-variance-authority` 仅在组件实现实际需要时使用。

不抽取 Noesis 业务组件，不建立跨仓库 UI 包，不一次性引入完整组件库。

### 4.2 视觉基线

参考 Noesis 的设计语言：

- 深色优先，同时支持浅色主题；
- 半透明背景、低对比边框和紫蓝主色；
- 绿色表示成功、黄色表示等待、红色表示错误、灰色表示离线；
- 状态同时使用文字、图标和颜色；
- 卡片、表格、页面标题、空状态和错误状态保持一致；
- 不展示无法工作的搜索框、终端或上传入口；
- 不使用虚构的机器指标和任务数据。

主题和侧栏折叠状态可存入 localStorage；身份、Token、Job、文件内容和签名 URL不得持久化。

## 5. 应用 Shell 与路由

### 5.1 认证状态

Frontend 继续使用 HttpOnly Cookie Session：

```text
checking → authenticated → ConsoleShell
         ↘ unauthenticated → LoginPage
```

启动时调用 `GET /api/auth/me`。SDK 返回 401 时由 Frontend 统一清除身份状态并跳转 `/login`。

登录页采用 Noesis 类似的双栏结构：

- 左侧展示 VCPDeck 定位、能力和安全边界；
- 右侧为用户名/密码表单；
- 提交期间禁用表单；
- 登录失败显示统一安全文案，不根据当前 Server 500 差异推断账号状态；
- 提供深浅主题切换。

### 5.2 ConsoleShell

```text
ConsoleShell
├── 桌面可折叠侧栏
├── 顶部栏：当前页面、主题、用户菜单
├── 移动端横向导航
├── 面包屑/页面上下文
└── 页面内容区
```

一级导航：

```text
概览
机器
任务
FRP
存储
设置
```

文件不作为一级导航，因为文件操作必须先确定 Client。

### 5.3 路由

```text
/login
/dashboard
/machines
/machines/:clientId/overview
/machines/:clientId/execute
/machines/:clientId/files
/machines/:clientId/frp
/machines/:clientId/jobs
/jobs
/jobs/:jobId
/frp
/storage
/settings/profile
/settings/tokens
/settings/identities
```

`/settings/identities` 仅对 admin 展示；Server 仍是最终鉴权边界。

## 6. `@vcpdeck/sdk`

### 6.1 目的与边界

新增框架无关的最小 SDK：

```text
@vcpdeck/shared
        ↓
 @vcpdeck/sdk
   ↙     ↓      ↘
Frontend  CLI   第三方/Skill
```

本次完成 SDK 和 Frontend 接入，不实现 CLI 或 Skill。

SDK 负责：

- REST 请求；
- Cookie/Bearer 认证；
- `@vcpdeck/shared` 类型；
- HTTP、网络和中止错误归一化；
- Job 创建、查询、取消和等待；
- 各领域 API；
- base URL、标准 fetch 注入和 AbortSignal。

SDK 不负责：

- React hooks、Context 和路由；
- Toast、Dialog 和中文 UI 文案；
- Token/localStorage 持久化；
- 危险操作确认；
- 页面筛选和字段脱敏；
- Blob、Node Stream 或本地保存路径的统一抽象；
- WebSocket。

### 6.2 文件结构

```text
packages/sdk/src/
├── client.ts
├── auth.ts
├── clients.ts
├── jobs.ts
├── files.ts
├── storage.ts
├── aliyundrive.ts
├── frp.ts
└── index.ts
```

`VcpDeckClient` 是唯一具体客户端，不增加 interface、factory 或 transport 层。

### 6.3 实例化

Browser Cookie：

```ts
const client = new VcpDeckClient({
  baseUrl: "",
  auth: { type: "cookie" },
});
```

后续 Bearer 调用：

```ts
const client = new VcpDeckClient({
  baseUrl: "http://localhost:3001",
  auth: { type: "bearer", token },
});
```

标准 `fetch` 可注入用于测试或特殊运行时。

### 6.4 公开能力

```ts
client.health.get();

client.auth.login(input);
client.auth.logout();
client.auth.me();
client.auth.updateMe(input);
client.auth.tokens.list();
client.auth.tokens.create(input);
client.auth.tokens.revoke(id);

client.identities.list();
client.identities.create(input);
client.identities.disable(id);
client.identities.enable(id);

client.clients.list();

client.jobs.list();
client.jobs.get(jobId);
client.jobs.create(input);
client.jobs.cancel(jobId);
client.jobs.wait(jobId, options);

client.files.roots(clientId);
client.files.list(input);
client.files.stat(input);
client.files.readText(input);
client.files.writeText(input);
client.files.mkdir(input);
client.files.delete(input);
client.files.move(input);
client.files.export(input);
client.files.import(input);

client.storage.createUploadToken(input);
client.storage.createDownloadToken(input);
client.storage.delete(key);
client.storage.setBackend(input);

client.aliyundrive.status();
client.aliyundrive.configure(input);
client.aliyundrive.startOAuth();
client.aliyundrive.completeOAuth(input);
client.aliyundrive.revoke();

client.frp.list(clientId?);
client.frp.get(id);
client.frp.create(input);
client.frp.delete(id);
```

`files.*` 是 Job 创建和等待的薄封装；底层 `jobs.*` 仍公开给高级调用者。

### 6.5 错误模型

```ts
class VcpDeckApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
}
```

SDK 必须区分：

- HTTP 非 2xx；
- 网络不可达；
- AbortSignal 中止；
- JSON 和空响应。

SDK 不翻译 UI 文案，不猜测当前登录/资料更新 500 的业务含义，不将 Token、签名 URL、请求体或原始敏感异常写入错误消息。

### 6.6 Job 等待

```text
等待 1 秒
→ 查询详情
→ 再等待 2 秒
→ 再等待 5 秒
→ 后续保持 5 秒
→ done/error/cancelled 返回
→ disconnected 继续等待
→ AbortSignal 只中止本地等待
```

SDK 不在本地超时或中止时自动取消远端 Job。

### 6.7 文件字节边界

SDK 统一预签名 URL 和元数据，但不抽象实际字节传输：

- Browser 下载由 Frontend 立即触发；
- 后续 CLI 自己处理 Node Stream 和保存路径；
- 签名 URL 不缓存、不记录；
- 本地上传后 import 在 Server 补齐 `fileId` 接口前不暴露。

## 7. Frontend 数据层

```text
packages/frontend/src/api/
├── context.tsx
└── hooks/
    ├── use-clients.ts
    ├── use-jobs.ts
    ├── use-job-action.ts
    ├── use-file-browser.ts
    ├── use-frp-mappings.ts
    └── use-storage-status.ts
```

Frontend hooks 只负责 React UI 状态，所有请求和轮询调用 SDK。

每个 hook 明确维护：

```text
idle | loading | success | empty | error
```

要求：

- 使用 AbortController；
- 卸载时停止请求和轮询；
- 刷新时保留已有数据并显示轻量 refreshing；
- 页面不可见时暂停列表定时刷新；
- Job 当前运行时使用 `jobs.wait()`，不再创建第二套详情轮询。

全局 Job 列表每 10 秒刷新一次，Frontend 在内存中按 Client、type 和 status 筛选。

## 8. 页面与数据流

### 8.1 概览

聚合：

- 在线机器：`clients.list()`；
- 运行、等待和异常任务：`jobs.list()`；
- FRP active/inactive/error：`frp.list()`；
- 阿里云盘授权状态：`aliyundrive.status()`；
- 最近任务表。

不展示 CPU、内存、磁盘、离线历史或 stdout。

### 8.2 机器列表

响应式卡片展示：

- hostname、clientId、OS；
- 在线状态和最后心跳；
- capability 标签；
- 执行、文件和 FRP 快捷入口。

只展示 Server 返回的在线 Client。

### 8.3 机器工作区

固定标题保留机器身份、在线状态和 capabilities。标签使用 URL：

```text
概览｜执行｜文件｜FRP｜任务记录
```

#### 概览

展示该 Client 的能力、最后心跳、最近 Job 和 FRP 映射摘要。

#### 执行

支持 command 与 script 两种表单：

- command：command、cwd、timeout；
- script：executable、args、script、cwd、timeout。

结果显示：

- Job ID；
- 状态；
- exitCode；
- startedAt、finishedAt 和耗时；
- errorCode 和安全错误文案；
- 固定提示“当前 Server 未持久化过程输出”。

不渲染终端占位，不伪造 stdout/stderr。

#### 任务记录

从最近 100 条 Job 中按 clientId 过滤，并明确不是完整历史。

### 8.4 文件资源管理器

#### 数据流

```text
进入文件标签
→ files.roots(clientId)
→ 创建并等待 file.roots Job
→ 左栏展示 / 或可访问 Windows 盘符
→ 选择根
→ files.list(clientId, rootDir, path)
→ 逐级浏览
```

#### 桌面布局

三栏资源管理器：

1. 左栏：根目录、当前机器和可用操作；
2. 中栏：面包屑、目录表格、刷新和选择；
3. 右栏：stat、文本预览、编辑、移动、导出和删除。

中等屏幕隐藏右侧预览；移动端使用文件列表到独立详情页。

#### 行为

- 目录点击进入；
- 文本文件显式点击预览；
- `file.readText` 超过 256 KiB 时建议 export；
- 编辑通过 `file.writeText`，保存前展示完整远程路径；
- mkdir 后刷新当前目录；
- 删除和覆盖移动要求输入完整目标路径；
- export 完成后申请 download token 并立即触发浏览器下载；
- 不展示本地上传/import 入口；
- 只展示 `file.roots` 实际返回的根；
- IO/权限错误就地展示，不尝试绕过操作系统权限；
- 文件页持续提示“仅限可信操作者”，因为当前 Server 无细粒度权限且 symlink 安全检查仍有缺陷。

### 8.5 全局任务

展示：

- status、type、Client、创建人、来源、创建时间和耗时；
- Client、type 和 status 的前端筛选；
- 按 type 脱敏后的 payload 和 result；
- pending/running/disconnected 的持续追踪；
- 仅 exec 提供“可靠取消”入口。

固定说明：

- 只包含最近 100 条；
- 跨身份可见；
- 不是“我的任务”列表。

### 8.6 FRP

全局页显示全部映射；机器标签只显示当前 Client。

创建字段：

- name；
- proxyType；
- localIp；
- localPort；
- remotePort；
- customDomain。

创建后按映射 ID 轮询：

```text
inactive → active | error
```

删除必须输入映射名称。成功文案固定为：

> 已提交删除并移除 Server 映射记录，Client 清理状态尚未确认。

### 8.7 Storage 与阿里云盘

采用保守接入：

- 使用 `/api/aliyundrive/status` 展示安全字段；
- 配置 clientId、可选 clientSecret 和 transferFolder；
- OAuth start 后打开 authorizationUrl；
- 用户回填 code 并 complete；
- complete 后刷新 status；
- 后端切换只调用 `storage.setBackend({ kind })`；
- 不调用或渲染 `GET /api/storage/config`；
- OAuth code 成功提交后立即清空；
- revoke 使用普通确认 Dialog；
- 页面提示这些管理接口当前并非 admin-only。

### 8.8 设置

```text
个人资料｜CLI Token｜身份管理（admin）
```

- 迁移现有功能到统一 Shell 和组件；
- 新 Token 只在一次性 Dialog 中显示，关闭即清空；
- Token revoke 使用普通确认；
- 身份禁用/启用保留 admin UI 门；
- 明确普通身份具有全部远程操作权限，admin 只多身份管理能力。

## 9. 错误与安全交互

### 9.1 页面错误映射

| 类型 | 行为 |
|---|---|
| 401 | 清除身份状态并跳登录 |
| 403 | 显示权限不足，不自动重试 |
| 网络不可达/5xx | 保留用户输入，显示重试 |
| Job/业务错误 | 在操作区域显示 code 和安全文案 |

重要错误就地显示，Toast 只用于短暂成功反馈。

### 9.2 分级确认

普通确认 Dialog：

- Token revoke；
- 阿里云盘本地授权 revoke；
- 身份禁用。

输入目标确认：

- 删除文件/目录；
- 覆盖移动；
- 删除 Storage 对象；
- 删除 FRP 映射。

用户输入必须与页面展示的完整路径、对象 key 或映射名称完全匹配。默认焦点位于取消按钮。

### 9.3 敏感信息

- Cookie 保持 HttpOnly；
- 密码、clientSecret 和 OAuth code 不进入 URL、localStorage 或日志；
- 新 Token 仅存在于当前 React state；
- 签名 URL 仅在下载函数局部使用；
- Job payload 按 type 选择字段展示；
- 不提供原始 JSON dump；
- command/script 长内容默认折叠，复制时提示可能含敏感信息；
- 不增加通用请求日志中间件。

## 10. 可访问性与响应式

- 所有表单控件有可见 Label；
- Dialog、Tabs 和 Dropdown 使用 Radix 语义及焦点管理；
- 状态不只依靠颜色；
- loading 使用 `aria-busy`，错误使用适当 live region；
- 键盘可完成导航、表格选择和确认交互；
- 触控目标不小于 44px；
- 桌面侧栏可折叠；
- 移动端主导航横向滚动；
- 文件三栏在中屏隐藏预览，移动端改用列表到详情。

## 11. 测试设计

### 11.1 SDK 单元测试

覆盖：

- Cookie 和 Bearer 请求行为；
- JSON、空响应和非 JSON 错误；
- `VcpDeckApiError` status/code；
- 网络错误与 AbortSignal；
- `jobs.wait()` 的 1s/2s/5s 退避；
- done/error/cancelled 终态；
- disconnected 继续等待；
- `files.roots/list/readText` Job 封装；
- 错误对象不暴露 Token 或签名 URL。

通过注入标准 fetch 测试，不引入 mock server 框架。

### 11.2 Frontend 行为测试

覆盖：

- Auth checking、登录成功和 401 跳转；
- Shell 导航和 admin-only 入口；
- 机器 loading/empty/error/success；
- command/script 创建及诚实结果摘要；
- 轮询终态和组件卸载中止；
- `file.roots → 选择根 → file.list`；
- 文本大小限制；
- 删除/覆盖输入确认；
- FRP 创建轮询与删除限制文案；
- Storage 页面不调用原始 config；
- Token 一次性展示和关闭清空。

断言用户行为和可见结果，不断言 Tailwind class，不使用大段快照。

### 11.3 浏览器端到端验收

使用真实 Server 和 Client 验证：

1. Cookie 登录并进入控制台；
2. 在线机器出现在概览和机器页；
3. 创建 command/script Job 并看到最终摘要；
4. Windows 展示实际可访问盘符，Linux 展示 `/`；
5. 浏览目录、读取/写入文本、创建目录和导出文件；
6. 危险操作不能跳过确认；
7. FRP 创建进入 active/error；
8. 阿里云盘 OAuth 不泄露凭证；
9. 深浅主题和移动端布局可用；
10. 控制台无未处理异常，离开页面后轮询停止。

以下不作为成功标准：

- 实时 stdout/stderr；
- 本地上传后 import；
- FRP Client 删除确认；
- `agent.run`。

## 12. 组件边界

推荐按清晰职责拆分，不建立推测性抽象：

```text
src/
├── app/
│   ├── console-shell.tsx
│   ├── routes.tsx
│   └── theme.ts
├── api/
│   ├── context.tsx
│   └── hooks/
├── components/
│   ├── ui/
│   ├── page-heading.tsx
│   ├── status-chip.tsx
│   ├── async-state.tsx
│   └── confirm-target-dialog.tsx
├── pages/
│   ├── login/
│   ├── dashboard/
│   ├── machines/
│   ├── jobs/
│   ├── frp/
│   ├── storage/
│   └── settings/
└── main.tsx
```

边界规则：

- UI primitives 不知道 VCPDeck API；
- 页面通过 hooks 调 SDK；
- SDK 不依赖 React；
- Job 轮询只有 SDK 一份实现；
- 文件浏览状态只属于机器文件页面；
- 危险确认由可复用 Dialog 实现，但每个页面明确提供目标和影响文案。

## 13. 不做事项

- 不修改 Server 路由或数据模型；
- 不实现 CLI 和 Skill；
- 不实现 WebSocket；
- 不持久化 stdout/stderr；
- 不补本地上传 import 接口；
- 不实现 `agent.run`；
- 不增加权限系统；
- 不抽取跨仓库 UI 包；
- 不引入 React Query、Redux 或通用状态框架；
- 不建立通用 repository、factory、provider 或代码生成器；
- 不展示原始 Storage config；
- 不伪造 Server 不具备的数据。

## 14. 自审结论

- 无 TBD、TODO 或占位需求；
- 设计范围聚焦 Frontend、SDK 与现有 Server 对接；
- SDK 有 Frontend、后续 CLI 和第三方/Skill 三个明确消费者，不属于推测性抽象；
- 操作优先导航、机器标签页和文件三栏布局相互一致；
- REST 轮询与“不提供实时输出”的页面设计一致；
- `file.roots`、Linux `/` 和 Windows 多盘符契约与当前代码一致；
- Storage、import、FRP 删除、权限和 symlink 风险均未被隐藏；
- 测试与验收不要求当前 Server 无法保证的能力；
- 本规格可由一个后续实现计划分阶段完成，无需拆成多个独立产品规格。
