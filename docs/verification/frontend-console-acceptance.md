# VCPDeck 控制台人工验收清单

> 适用范围：`@vcpdeck/sdk` + Frontend 与当前 Server/Client 的完整对接
>
> 验收方式：按顺序执行，每项在 `结果` 栏勾选。发现问题时记录页面、操作、实际结果、浏览器 Console 和 Network 请求。
>
> 重要边界：本文只验收当前已实现能力，不把实时 stdout/stderr、本地上传后 import、离线 Client 历史或 `agent.run` 作为通过条件。

---

## 0. 验收记录

| 项目 | 填写内容 |
|---|---|
| 验收日期 |  |
| 验收人 |  |
| Git Commit |  |
| 操作系统 |  |
| 浏览器及版本 |  |
| Server 地址 | `http://localhost:3001` |
| Frontend 地址 | `http://localhost:5173` 或 Vite 实际输出地址 |
| Client ID |  |
| Client 主机名 |  |

最终结论：

- [ ] 通过
- [ ] 有条件通过
- [ ] 不通过

遗留问题：

```text

```

---

## 1. 前置准备

### 1.1 安装、测试和构建

在项目根目录执行：

```bash
pnpm install
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/frontend test
pnpm build
```

预期：

- SDK 测试全部通过；
- Frontend 测试全部通过；
- workspace 所有包构建成功；
- Vite 可能提示第三方包的 `"use client"` 被忽略，这不是验收失败。

结果：

- [ ] 通过
- [ ] 不通过

备注：

```text

```

### 1.2 可选：重置开发数据库

> **破坏性操作：** 会清空开发环境的身份、Token、Job、FRP 和 Storage 配置。仅在确认允许重置时执行。

先停止 Server，再执行：

```bash
rm -f "packages/server/prisma/dev.db" \
      "packages/server/prisma/dev.db-journal" \
      "packages/server/prisma/dev.db-shm" \
      "packages/server/prisma/dev.db-wal"
```

本文后续示例账号：

```text
用户名：admin
密码：dev123456
```

### 1.3 启动 Server

新终端执行：

```bash
cd "packages/server"
VCPDECK_ADMIN_PASSWORD="dev123456" \
VCPDECK_FRONTEND_ORIGIN="http://localhost:5173" \
VCPDECK_PSK="vcpdeck-dev-psk" \
pnpm start
```

如果 Vite 使用其他端口，例如 `5174`，将 `VCPDECK_FRONTEND_ORIGIN` 改为完整实际地址后重启 Server。

预期日志：

```text
[bootstrap] admin identity created: admin
VCPDeck server listening on http://localhost:3001
```

已有 admin 时不会重复创建。

健康检查：

```bash
curl "http://localhost:3001/api/health"
```

预期：

```json
{"ok":true}
```

结果：

- [ ] Server 启动成功
- [ ] 健康检查通过

### 1.4 启动 Client

新终端执行：

```bash
cd "packages/client"
VCPDECK_SERVER="http://localhost:3001" \
VCPDECK_PSK="vcpdeck-dev-psk" \
pnpm start
```

预期日志：

```text
[vcpdeck] connected as <clientId>
```

Client 的基础 capability 应至少包含：

```text
exec
file.read
file.write
```

只有本机可用 frpc binary 时才包含 `frp`。没有 `frp` capability 时，FRP 实机创建属于条件验收，不应判定整体验收失败。

结果：

- [ ] Client 连接成功
- [ ] Client ID 已记录
- [ ] capability 与本机环境一致

### 1.5 启动 Frontend

新终端执行：

```bash
cd "packages/frontend"
pnpm dev
```

记录 Vite 输出的实际 URL，例如：

```text
http://localhost:5173
```

结果：

- [ ] Frontend 启动成功
- [ ] 浏览器能打开 VCPDeck 登录页

---

## 2. 登录、认证与 Shell

### 2.1 正确凭据登录

操作：

1. 打开 `/login`；
2. 输入 `admin`；
3. 输入启动 Server 时设置的密码；
4. 点击“登录”。

预期：

- 跳转到 `/dashboard`；
- 左侧显示 VCPDeck 主导航；
- 显示当前身份 `admin`；
- 页面不显示密码或 Session Token。

结果：

- [ ] 通过
- [ ] 不通过

### 2.2 错误密码

操作：退出登录后，用错误密码登录。

预期：

- 停留在登录页；
- 显示通用文案“登录失败，请检查用户名和密码”；
- 不通过错误差异泄露用户名是否存在。

结果：

- [ ] 通过
- [ ] 不通过

### 2.3 退出登录

操作：正确登录后点击右上角“退出登录”。

预期：

- 返回 `/login`；
- 再直接访问 `/dashboard` 会回到登录页；
- 不再显示原身份信息。

结果：

- [ ] 通过
- [ ] 不通过

### 2.4 主导航

登录后确认固定六项：

- [ ] 概览
- [ ] 机器
- [ ] 任务
- [ ] FRP
- [ ] 存储
- [ ] 设置

预期：导航可点击，刷新后仍停留在当前 URL 对应页面。

---

## 3. 概览 Dashboard

打开 `/dashboard`。

| 检查项 | 预期 | 结果 |
|---|---|---|
| 在线机器 | 与当前连接的 Client 数量一致 | [ ] |
| 进行中任务 | 只统计 pending/running/disconnected | [ ] |
| FRP 映射 | 显示真实映射总数和 active 数 | [ ] |
| 阿里云盘 | 显示未配置/待授权/已授权之一 | [ ] |
| 最近任务 | 来自 Server；无任务时显示空态 | [ ] |
| 真实性 | 不显示虚构 CPU、内存、磁盘或 stdout | [ ] |

失败记录：

```text

```

---

## 4. 机器列表与工作区

### 4.1 机器列表

打开 `/machines`。

预期：

- [ ] 显示真实在线 Client；
- [ ] 显示 hostname、clientId、OS；
- [ ] 显示在线状态和最后心跳；
- [ ] 显示 Server 返回的 capabilities；
- [ ] 不显示离线 Client 历史；
- [ ] 有“执行”“文件”“FRP”快捷入口。

### 4.2 工作区标签和深链刷新

进入任一机器，检查：

```text
概览｜执行｜文件｜FRP｜任务记录
```

逐项打开并刷新浏览器：

- [ ] `/machines/<clientId>/overview`
- [ ] `/machines/<clientId>/execute`
- [ ] `/machines/<clientId>/files`
- [ ] `/machines/<clientId>/frp`
- [ ] `/machines/<clientId>/jobs`

预期：刷新后仍显示同一机器和同一标签，不跳回默认页，不丢失 clientId。

---

## 5. 远程执行

> 使用无破坏性命令验收。不要输入包含真实密钥的命令。

### 5.1 Command 模式

操作：

1. 进入机器“执行”标签；
2. 保持“命令”模式；
3. 输入：

```text
node --version
```

1. 点击“执行命令”。

预期：

- [ ] 显示 Job ID；
- [ ] 状态最终为 `done`；
- [ ] 退出码为 `0`；
- [ ] 显示开始/完成时间或耗时；
- [ ] 固定显示“当前 Server 未持久化过程输出”；
- [ ] 页面不伪造或展示不存在的 stdout。

### 5.2 Script 模式

切换“脚本”模式，使用：

```text
executable: node
args: 留空
script: console.log("vcpdeck-script-qa")
```

预期：

- [ ] Job 最终为 `done`；
- [ ] 退出码为 `0`；
- [ ] 仍不伪造实时输出；
- [ ] 页面不显示原始 Job payload dump。

### 5.3 错误状态

执行一个明确失败但无破坏性的命令，例如不存在的 executable 或退出码非零脚本。

预期：

- [ ] 状态为 `error`；
- [ ] 显示稳定 errorCode（若 Server 返回）；
- [ ] 显示安全错误信息；
- [ ] 不显示 stack、密钥或完整敏感 payload。

---

## 6. Job 列表、详情与取消

### 6.1 全局 Job 列表

打开 `/jobs`。

预期：

- [ ] 标题明确“最近 100 条任务”；
- [ ] 明确“任务记录对所有已认证身份可见”；
- [ ] 可按 Client、type 或 status 筛选；
- [ ] 不把列表描述为“我的任务”；
- [ ] 不直接渲染原始 payload；
- [ ] 命令/脚本只显示安全摘要。

### 6.2 Job 详情

打开一个 Job。

预期：

- [ ] 显示 Job ID、Client、类型、状态、创建人和来源；
- [ ] 显示安全的类型化摘要；
- [ ] 不显示 raw payload JSON；
- [ ] 不显示不存在的 stdout/stderr。

### 6.3 取消边界

预期：

- [ ] 只有 pending/running 的 `exec` Job 显示“取消任务”；
- [ ] 文件、FRP 等非 exec Job 不宣称可靠取消；
- [ ] 取消后等待终态；
- [ ] 离开页面后停止本地轮询；
- [ ] 停止本地轮询不应被描述为远端 Job 已取消。

---

## 7. 文件资源管理器

> 文件功能只面向可信操作者。建议使用专门临时目录和测试文本，不要在生产目录验收删除或移动。

### 7.1 文件根

进入机器“文件”标签。

预期：

- [ ] 先显示“正在发现文件根…”；
- [ ] Windows 显示 Client 实际返回的盘符，例如 `C:\`、`D:\`；
- [ ] Linux 显示 Client 实际返回的 `/` 或配置根；
- [ ] 页面不猜测、不额外补出不存在的文件根；
- [ ] 页面常驻提示可信操作者和 symlink 风险。

### 7.2 目录列表

选择一个文件根。

预期：

- [ ] 显示当前完整路径；
- [ ] 显示真实目录和文件；
- [ ] 可进入目录；
- [ ] “上一级”可用且不会越过 root；
- [ ] “刷新目录”可重新读取当前目录。

### 7.3 新建目录

输入一个临时目录名，例如：

```text
vcpdeck-acceptance-temp
```

点击“新建目录”。

预期：

- [ ] 创建成功后列表刷新；
- [ ] 新目录出现在当前目录中。

### 7.4 文本读取与保存

准备小于 256 KiB 的测试文本文件，选中该文件。

预期：

- [ ] 右侧显示文件类型、大小、修改时间；
- [ ] 文本内容正确读取；
- [ ] 修改后点击“保存”，远程文件内容确实变化；
- [ ] 不把文件内容写入浏览器 localStorage。

### 7.5 大文本限制

选中大于 256 KiB 的文本文件。

预期：

- [ ] 不在页面直接加载全文；
- [ ] 显示“文本超过 256 KiB，请使用导出下载”。

### 7.6 导出下载

选中测试文件，点击“导出下载”。

预期：

- [ ] 创建 `file.export` Job；
- [ ] Job 完成后请求 download token；
- [ ] 浏览器立即下载文件；
- [ ] 下载内容与远程文件一致；
- [ ] 页面不持久化签名 URL。

### 7.7 移动与覆盖确认

操作：将测试文件移动到一个不存在的目标路径。

预期：

- [ ] 首次调用不带覆盖；
- [ ] 正常移动成功并刷新列表；
- [ ] 目标已存在时，不会静默覆盖；
- [ ] 只有输入完整目标路径后才能确认覆盖。

### 7.8 删除确认

选中临时测试文件或目录并点击“删除”。

预期：

- [ ] Dialog 显示完整目标，例如 `D:\vcpdeck-acceptance-temp`；
- [ ] 输入不完整或不一致时“确认删除”保持禁用；
- [ ] 输入完全一致后才能删除；
- [ ] 删除完成后列表刷新。

### 7.9 不应出现

- [ ] 页面没有“本地上传/import”入口；
- [ ] 页面不要求用户自由填写 `rootDir`；
- [ ] 页面不声称 symlink/junction 已构成可靠安全边界。

---

## 8. FRP 管理（条件验收）

> 只有 Client capability 包含 `frp` 且 frpc/frps 环境可用时执行完整创建验收。

### 8.1 列表范围

- [ ] `/frp` 显示全部映射；
- [ ] 机器“FRP”标签只显示当前 Client 的映射。

### 8.2 创建映射

建议使用一个无冲突的本地测试端口，填写：

```text
name: acceptance-tcp
proxyType: tcp
localIp: 127.0.0.1
localPort: <测试服务端口>
remotePort: 留空或填可用端口
```

预期：

- [ ] 创建后初始状态可为 `inactive`；
- [ ] 页面按 1s → 2s → 5s 轮询；
- [ ] 最终进入 `active` 或 `error`；
- [ ] 页面不会永久高频轮询；
- [ ] Client 缺少 `frp` capability 时显示 Server 拒绝，不绕过校验。

### 8.3 删除映射

点击删除。

预期：

- [ ] 必须输入完整映射名称；
- [ ] 删除后移除 Server 映射记录；
- [ ] 页面固定显示“Client 清理状态尚未确认”；
- [ ] 页面不宣称远端 frpc 已确认清理。

> 已知缺陷：删除流程存在 Server 记录先删除、Client 清理回调后更新失败的竞态。自动化 FRP 测试可能表现为映射记录已删除，但 frps proxy 暂时仍为 online。此项必须记录，不得用 UI 文案掩盖。

结果：

- [ ] 完整通过
- [ ] 因环境无 `frp` capability，按条件跳过
- [ ] 发现已知删除竞态
- [ ] 其他失败

---

## 9. Storage 与阿里云盘

### 9.1 安全状态页面

打开 `/storage`。

预期：

- [ ] 显示 configured、authorized、isExpired；
- [ ] 显示 clientId、transferFolder、driveId、expiresAt 等安全字段；
- [ ] 显示“当前接口非 admin-only”；
- [ ] Client Secret 输入框为空，不回填；
- [ ] 浏览器 Network 中没有 `GET /api/storage/config`；
- [ ] 页面不显示 access token、refresh token 或 client secret。

### 9.2 Storage 后端切换

分别点击“使用本地存储”和“使用阿里云盘”。

预期：

- [ ] 仅发送 `{ kind: "local" }` 或 `{ kind: "alibaba" }`；
- [ ] 页面不读取或渲染接口原始配置；
- [ ] 没有真实阿里云盘配置时，切换到 alibaba 失败应显示安全错误，而不是泄露配置。

### 9.3 配置保存（有测试凭据时）

填写专用测试 `clientId`、`clientSecret` 和传输目录。

预期：

- [ ] 保存后 Client Secret 输入框清空；
- [ ] 状态刷新；
- [ ] 页面和 Console 不出现 clientSecret 明文。

### 9.4 OAuth（有测试账号时）

操作：

1. 点击“开始授权”；
2. 在新标签页完成授权；
3. 将 code 填回页面；
4. 提交 state + code。

预期：

- [ ] 只在用户点击后打开新标签页；
- [ ] authorizationUrl 必须为 HTTPS；
- [ ] authorizationUrl origin 必须与安全状态中的 openapiBase origin 一致；
- [ ] 成功后 state 和 code 清空；
- [ ] 状态刷新为已授权；
- [ ] 页面不记录 OAuth code 或 Token。

### 9.5 撤销授权

预期：

- [ ] 点击撤销先出现普通确认 Dialog；
- [ ] 确认后状态刷新；
- [ ] 不显示原始 Token。

---

## 10. 设置、Token 与身份

### 10.1 个人资料

打开 `/settings/profile`。

预期：

- [ ] 当前密码必填；
- [ ] 新用户名和新密码可选；
- [ ] 成功后清空当前密码和新密码；
- [ ] 失败只显示通用安全文案；
- [ ] 不显示 stack 或密码内容。

### 10.2 Token 一次性显示

打开 `/settings/tokens`，创建标签为 `acceptance-token` 的 Token。

预期：

- [ ] Token 明文以 `vcp_` 开头；
- [ ] 明文只在 Dialog 中显示；
- [ ] Dialog 明确提示“只显示一次”；
- [ ] 点击“我已保存”后，DOM 中不再存在明文；
- [ ] 刷新页面后不能再次查看明文；
- [ ] localStorage 中不存在 Token。

### 10.3 撤销 Token

预期：

- [ ] 点击“撤销 Token”不会立即执行；
- [ ] 确认 Dialog 出现；
- [ ] 点击“确认撤销”后 Token 失效。

### 10.4 身份管理：admin

打开 `/settings/identities`。

预期：

- [ ] admin 可看到“身份管理”标签；
- [ ] 可创建新身份；
- [ ] 禁用身份前出现确认 Dialog；
- [ ] 禁用后该身份无法登录；
- [ ] 重新启用后可登录。

### 10.5 身份管理：普通身份

使用普通身份登录。

预期：

- [ ] 设置导航不显示“身份管理”；
- [ ] 直接访问 `/settings/identities` 会跳转到 `/settings/profile`；
- [ ] 不渲染创建/禁用/启用身份 UI。

### 10.6 权限提示

- [ ] 设置页固定说明“普通身份拥有全部远程业务权限”；
- [ ] UI 隐藏不是 Server 授权边界；
- [ ] 只向可信操作者发放身份和 Token。

---

## 11. 主题、响应式与可访问性基础

### 11.1 深浅主题

- [ ] 默认主题可正常显示；
- [ ] 点击“切换主题”后颜色实际变化；
- [ ] 刷新后主题偏好保留；
- [ ] localStorage 只保存 theme/sidebarCollapsed，不保存身份、Token、Job、文件内容或签名 URL。

### 11.2 侧栏

- [ ] 桌面端可收起/展开侧栏；
- [ ] 刷新后折叠偏好保留；
- [ ] 折叠后导航仍可辨识和操作。

### 11.3 移动端

将浏览器调整为约 `390 × 844`。

预期：

- [ ] 显示“移动导航”；
- [ ] 六个主导航入口均可访问；
- [ ] 页面无横向溢出；
- [ ] 表单和危险确认 Dialog 可操作；
- [ ] 文件页面按纵向顺序显示根、列表和详情。

### 11.4 键盘与标签

- [ ] Tab 可聚焦主要按钮、链接和输入框；
- [ ] 输入框有可读 label；
- [ ] Dialog 有标题和描述；
- [ ] 破坏性按钮与普通按钮视觉可区分。

---

## 12. 网络、轮询与安全检查

打开浏览器 DevTools → Network。

### 12.1 资源请求

- [ ] 页面切换时旧请求被 abort；
- [ ] abort 不显示为业务错误；
- [ ] Dashboard 并行请求 clients/jobs/frp/aliyundrive status；
- [ ] Storage 页面不请求 `GET /api/storage/config`。

### 12.2 Job 轮询

- [ ] Job 等待节奏为约 1 秒、2 秒、5 秒、后续 5 秒；
- [ ] `done/error/cancelled` 后停止；
- [ ] `disconnected` 不被错误视为终态；
- [ ] 离开执行页后不再继续轮询该 Job；
- [ ] 页面卸载导致的 AbortError 不出现在 Console 中。

### 12.3 列表刷新

- [ ] Job 列表约每 10 秒刷新；
- [ ] 页面不可见时不持续刷新；
- [ ] 返回页面后可继续正常刷新。

### 12.4 敏感信息

确认页面、Console、localStorage 和普通错误中没有：

- [ ] 密码；
- [ ] Session Cookie；
- [ ] Bearer Token（一次性 Dialog 展示期间除外）；
- [ ] Client PSK；
- [ ] 阿里云盘 client secret/access token/refresh token；
- [ ] FRP auth token；
- [ ] Storage 签名 URL 的持久化记录；
- [ ] 未脱敏的原始 Job payload。

源码扫描：

```bash
rg "storage\.getConfig|/api/storage/config.*GET|console\.(log|debug).*token|localStorage.*token" \
  "packages/frontend/src" "packages/sdk/src"
```

预期：没有违规匹配。

---

## 13. 明确不作为失败的当前限制

以下行为是当前架构限制，不应误报为 Frontend 验收失败：

- [ ] REST 不提供实时 stdout/stderr；
- [ ] Frontend 不提供本地上传后 import；
- [ ] Server 不提供离线 Client 历史；
- [ ] `agent.run` 不可用；
- [ ] 只有 exec 取消被视为可靠；
- [ ] Job 最近列表只有最多 100 条且跨身份可见；
- [ ] 文件路径/symlink 边界仍有已知 Server/Client 风险；
- [ ] FRP 删除不能稳定证明 Client frpc 已清理；
- [ ] 阿里云盘和 Storage 接口当前不是 admin-only。

如果产品期望改变上述限制，应另立 Server/Client 需求，不应由 Frontend 伪造补齐。

---

## 14. 自动化回归

人工验收完成后，在没有手工启动的 Server/Client 占用端口时，**串行**执行：

```bash
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/sdk build
pnpm --filter @vcpdeck/frontend build
pnpm build
pnpm test
pnpm test:frp
```

> 不要并行运行 `pnpm test` 和 `pnpm test:frp`，两套 harness 会竞争 Server/FRP 端口。

记录：

| 命令 | 预期 | 实际 | 结果 |
|---|---|---|---|
| SDK test | 全部通过 |  | [ ] |
| Frontend test | 全部通过 |  | [ ] |
| SDK build | exit 0 |  | [ ] |
| Frontend build | exit 0 |  | [ ] |
| workspace build | exit 0 |  | [ ] |
| `pnpm test` | 75/75 |  | [ ] |
| `pnpm test:frp` | 20/20；若删除竞态失败须记录 |  | [ ] |

---

## 15. 缺陷记录模板

每个问题复制一份：

```markdown
### [页面/模块] 问题标题

- 严重级别：阻塞 / 严重 / 一般 / 建议
- 页面 URL：
- Client ID：
- 前置条件：
- 操作步骤：
  1.
  2.
  3.
- 预期结果：
- 实际结果：
- 是否稳定复现：是 / 否
- 浏览器 Console：
- 相关 Network 请求：
- Job ID / FRP mapping ID：
- 截图或录屏：
- 补充说明：
```

---

## 16. 最终签字

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 验收人 |  | 通过 / 有条件通过 / 不通过 |  |
| 开发确认 |  |  |  |

最终备注：

```text

```
