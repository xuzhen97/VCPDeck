# VCPDeck 统一对接指南设计

> 状态：已确认
> 日期：2026-07-26
> 目标文档：`docs/integration-guide.md`

## 1. 目标

编写一份可直接指导 Frontend、CLI 与 VCPDeck Skill 开发的统一对接指南。指南以当前代码实现为事实来源，完整说明已实现能力、部分实现限制、尚未实现能力和对接阻塞点，避免将历史设计中的规划误写为现状。

目标读者完成阅读后，应能：

- 选择正确的 Cookie 或 Bearer Token 认证方式；
- 调用 Client、Job、文件、Storage、阿里云盘和 FRP 接口；
- 使用 REST 轮询可靠判断 Job 终态；
- 为 Frontend、CLI 和 Skill 实现一致的危险操作保护；
- 按推荐顺序实施并依据 Definition of Done 验收。

## 2. 范围

指南覆盖：

1. 身份认证、个人资料、身份与 Token 管理；
2. 在线 Client 查询与 capability 判断；
3. Job 创建、列表、详情、取消和状态轮询；
4. `exec` 的 command 与 script 模式；
5. 轻量文件操作及文件 import/export；
6. Storage 预签名上传、下载、删除与后端配置；
7. 阿里云盘配置、OAuth、授权状态与撤销；
8. FRP 映射创建、列表、详情与删除；
9. Frontend、CLI、Skill 的实施顺序与验收清单；
10. 已知限制、代码与旧文档差异及后续扩展边界。

本次不实现接口、页面、CLI 命令或 Skill，不引入 SDK、代码生成器或新抽象。`agent.run`、WebSocket 实时对接和 stdout/stderr 持久化只作为未实现或后续扩展说明。

## 3. 事实来源

内容按以下优先级核对：

1. 当前 Server、Client 和 `@vcpdeck/shared` 代码；
2. Prisma 数据模型与现有集成测试；
3. 已完成的验证/实现文档；
4. 历史设计文档。

每项能力使用统一状态标记：

- **已实现，可直接对接**；
- **部分实现，存在限制**；
- **未实现 / 后续扩展**；
- **旧文档与代码不一致，以代码为准**。

接口条目附对应代码位置，方便实现变化后重新核验。

## 4. 文档结构

目标文档 `docs/integration-guide.md` 使用单文档结构：

1. 阅读说明与能力矩阵；
2. 公共对接约定；
3. 认证与身份管理；
4. 远程 Client 管理；
5. Job 通用接口；
6. 命令与脚本执行；
7. 远程文件管理；
8. Storage 与文件传输；
9. 阿里云盘配置及 OAuth；
10. FRP 端口映射；
11. Frontend 对接建议；
12. CLI 命令映射建议；
13. Skill 行为与安全规范；
14. 错误处理速查表；
15. 实施阶段与验收清单；
16. 当前限制及后续扩展。

每个 API 条目统一包含：

- 实现状态与鉴权要求；
- HTTP 方法和路径；
- 请求字段表；
- 可复制的 JSON 请求及响应；
- HTTP 失败状态和稳定错误码；无稳定错误码时明确说明；
- 调用流程和轮询终止条件；
- Frontend、CLI、Skill 注意事项；
- 对应实现位置。

## 5. 公共对接基线

### 5.1 认证

- Frontend 使用 HttpOnly `vcpdeck_session` Cookie，并在请求中携带 credentials；
- CLI 与 Skill 使用 `Authorization: Bearer vcp_...`；
- 登录和健康检查为公开接口，其余接口默认需要认证；
- 身份管理接口要求 admin；其他业务接口不区分 admin 与普通身份。

### 5.2 Job 轮询

首期三端统一使用 REST 轮询，不依赖 WebSocket：

```text
创建 Job
  → 1 秒后查询
  → 按 1s、2s、5s 退避
  → 后续保持 5s
  → done / error / cancelled 时停止
  → disconnected 不视为终态
```

调用端卸载、进程中断或超时时必须停止轮询。超时是调用端停止等待，不等同于 Job 已取消；需要取消时另调取消接口。

当前 stdout/stderr 只在 Client Socket.IO namespace 实时转发，不持久化到 Job。REST 轮询只能保证状态和最终结构化结果，不能取得过程输出。WebSocket 转发到 `/app`、断线补偿和输出 spool 均留作后续扩展。

### 5.3 能力判断

创建 Job 前，调用端根据 Client capabilities 控制入口：

- `exec` → `exec`；
- 读取、导出 → `file.read`；
- 写入、导入 → `file.write`；
- FRP → `frp`。

Server 校验仍是安全边界；调用端预检查只用于改善体验。

## 6. 功能流程

### 6.1 命令与脚本

调用端创建 `exec` Job。command 模式发送 shell command；script 模式发送 executable、args 和 stdin script。调用端轮询 Job，读取最终 `result.exitCode` 或 `errorCode/errorMessage`。文档明确当前无法通过 REST 获取过程输出。

### 6.2 轻量文件操作

`file.list`、`file.stat`、`file.readText`、`file.writeText`、`file.mkdir`、`file.delete`、`file.move` 均通过 Job 调度。所有路径相对调用方提供的 `rootDir`，Client 执行路径规范化与 realpath 检查。指南说明 256 KiB 默认文本读取上限、递归删除和覆盖移动的显式参数。

### 6.3 文件导出与导入

- 导出：创建 `file.export` Job，Client 将文件 PUT 到 Storage；终态结果提供 `fileId/key/size/sha256`，调用端再申请下载 URL。
- 导入：调用端申请上传 URL并 PUT 原始字节，再以相应 `fileId` 创建 `file.import` Job；Client 下载、校验 SHA-256，并以临时文件加 rename 写入目标。

指南必须指出当前通用 `POST /api/storage/upload-token` 的公开响应仅含 URL 与过期时间，而 import 所需的 `fileId` 关联能力需要按实际代码和测试复核；若公开流程不能稳定得到 `fileId`，应标记为对接阻塞点，而不是虚构响应字段。

### 6.4 Storage 与阿里云盘

完整记录预签名上传/下载、对象删除、后端配置读取与热切换，以及阿里云盘配置、OAuth start/complete、status、revoke。密钥字段不在示例响应、日志或 UI 回显中暴露。

### 6.5 FRP

创建映射后 REST 立即返回 `inactive` 映射，后台 Job 完成后变为 `active` 或 `error`。调用端查询映射详情或列表判断状态。删除接口当前先删除数据库映射再下发 Client 清理 Job，指南明确其异步语义和失败可见性限制。

## 7. 安全约束

| 操作 | Frontend | CLI | Skill |
|---|---|---|---|
| 删除文件/目录 | 展示路径并二次确认 | 显式 `--recursive` / `--force` | 复述目标与影响并取得确认 |
| 覆盖或移动目标 | 展示源和目标 | 显式 `--overwrite` | 复述目标与影响并取得确认 |
| 删除 FRP 映射 | 展示映射和公网地址 | 显式 `--force` | 复述目标与影响并取得确认 |
| 撤销 Token | 提醒当前调用可能失效 | 显式确认 | 取得确认后执行 |
| Storage/OAuth 配置 | 隐藏密钥 | 不打印密钥 | 不在日志或回复中暴露密钥 |

Token、密码、PSK、预签名 URL、阿里云盘凭证不得写入日志或 Skill 回复。命令、路径、环境信息和 Job payload 也按潜在敏感信息处理。调用端确认不能替代 Server 的认证、路径隔离和参数校验。

## 8. 三端实施建议

### 8.1 Frontend

先扩展现有 API 层和统一错误处理，再实现 Client/Job 页面，然后实现文件、Storage/阿里云盘和 FRP 页面。所有轮询在页面卸载和终态后清理；提供加载、空、错误、离线和 capability 不支持状态。

### 8.2 CLI

先完成 server URL 与 Token 配置、统一 HTTP 请求及 `--json` 输出，再实现 client/job/exec，随后文件、Storage/阿里云盘和 FRP。人类输出写 stdout/stderr 时不得泄密；退出码区分成功、远端失败、认证失败和本地超时。

### 8.3 Skill

先完善 setup、身份验证和 Client 选择，再建立自然语言意图到 CLI/API 的映射。默认调用 CLI 以复用认证、轮询和 JSON 输出；危险操作必须停在确认门前。Skill 只汇报安全摘要、Job ID、终态与下一步，不回显凭证或完整预签名 URL。

## 9. 验收标准

### Frontend Definition of Done

- Cookie 登录、退出及认证失效跳转正确；
- 可查询 Client、创建/取消/轮询 Job；
- capability、加载、空、错误和离线状态可见；
- 文件、Storage、阿里云盘和 FRP 流程符合接口实际行为；
- 危险操作二次确认，组件卸载后无残留轮询；
- 密钥和预签名 URL 不进入持久化日志。

### CLI Definition of Done

- Bearer Token 和 server URL 可配置且不被普通输出泄露；
- 支持人类输出和稳定 `--json` 输出；
- 正确处理 Job 终态、调用端超时与取消；
- 危险操作需要显式参数；
- 对认证、HTTP、远端 Job 失败返回可区分的非零退出码。

### Skill Definition of Done

- 意图可映射到已实现接口或 CLI 命令；
- Client 选择和 capability 检查明确；
- 危险操作执行前取得用户确认；
- 轮询只在终态停止，`disconnected` 不误判成功；
- 回复不泄露 Token、签名 URL、密码、PSK 或云盘凭证。

### 共同验收

使用当前 Server 与测试 Client 完成认证、Client 查询、exec、轻量文件操作、文件导入/导出、Storage 配置、阿里云盘 OAuth 和 FRP 的端到端检查。无法端到端验证的环节在指南中标记为限制或阻塞，不以设计预期代替证据。

## 10. 自审结论

- 无 TBD、TODO 或未决设计项；
- 文档目标、范围、结构和验收标准一致；
- 单一对接指南可由一个实施计划完成；
- REST 轮询、危险操作约束和三端职责无冲突；
- 已明确区分代码事实、历史设计和后续扩展；
- 文件 import 的 `fileId` 获取、实时输出和 `/app` 事件转发被明确要求按代码核实，不会误写为已可用能力。
