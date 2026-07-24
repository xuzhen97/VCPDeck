## Review

### Correct

- **文件传输不应通过 Socket.IO 传文件本体。**  
  `docs/server-client-interaction-design.md` §2「通信通道」明确规定：“Socket.IO 只传指令和数据，不传文件本体”；§7「存储与文件操作」进一步收紧为“Socket.IO 只传 FileRef”。因此不应通过 Socket.IO 发送 `Buffer`、Base64 或文件分片。
- **设计已经把 Job 与 Storage 区分为两个职责域。**  
  `docs/server-client-interaction-design.md` §1 架构图中 `Job Manager` 与 `Storage Service` 是独立组件；`docs/tech-stack.md:42-43` 也分别规划了：
  - `job`：远程命令下发、脚本执行、结果回写
  - `file`：远程文件读写、上传下载
- **当前核心 Job 生命周期与设计基本对齐。**  
  `packages/shared/src/index.ts:4-16` 已定义 dispatch、stdout/stderr、done、cancel、status report 等控制事件；`packages/server/prisma/schema.prisma:26-39` 已持久化命令 Job 的状态、输出、超时和起止时间。
- **文件功能当前未实现是已知的阶段性裁剪。**  
  `docs/superpowers/specs/2026-07-23-server-client-core-design.md:15` 明确写明“存储 / 文件操作 FileRef（§7）—— 接口预留，本次不实现”。因此当前缺口并非这轮核心实现遗漏，但 README 对外表述没有体现该状态。

### Blocker

- **[高] §7 当前“读取远程文件”的时序不能跨机器成立。**  
  `docs/server-client-interaction-design.md` §7 描述 Client 读取文件到临时目录，然后向 Server 返回 `{ jobId, localPath }`，接着由 Server 执行 `store(localPath)`。这个 `localPath` 位于远程 Client 文件系统，Server 的 Storage Service 无法直接访问它。  
  正确流程应是：
  1. Server 先创建一个受限、短期有效的上传 `FileRef`（`PUT`）。
  2. 通过 Job 控制消息把远程路径和该 `FileRef` 下发给 Client。
  3. Client 通过 HTTP `PUT` 将文件流直接上传到 Storage。
  4. Client 仅通过 Socket.IO 报告上传完成、文件 ID、大小或摘要。
  5. Server 给 Frontend 签发 `GET FileRef`，Frontend 直接下载。

  在实现文件功能前，必须先修正或补充这一协议，否则 Storage 与 Client 位于不同机器时无法工作。

---

## 设计结论

### 1. 文件管理是否应该属于 Job？

**结论：远程文件操作的控制生命周期应属于 Job；文件资源和 Storage 本身不应属于 Job。**

具体边界：

| 能力 | 是否属于 Job | 理由 |
|---|---:|---|
| 在指定 Client 上读取、写入、移动、删除文件 | 是 | 是异步远程操作，需要机器定位、排队、状态、断线、超时、取消和审计 |
| 文件上传/下载字节流 | 否 | 属于 Storage 数据面，应通过 HTTP/对象存储传输 |
| FileRef 签发、过期、权限、对象生命周期 | 否 | 属于 Storage/File 模块 |
| Job 产出的文件结果 | Job 只引用 | Job 保存 file ID/FileRef/result metadata，而不是文件本体 |

这一判断同时符合：

- `docs/server-client-interaction-design.md` §4：Job 承担远程操作生命周期。
- 同文档 §7：使用了 `job:read-file { jobId, path }`，说明远程文件动作本身按 Job 跟踪。
- 同文档 §1：Storage Service 与 Job Manager 分离。
- `docs/tech-stack.md:42-43`：`job` 与 `file` 是不同功能模块。

当前设计的不足是：§7 使用了 `job:read-file`，但 §8「事件汇总」没有列出这个事件，也没有定义对应 payload/result。建议不为每个动作无限增加 Socket.IO 事件，而是最小化扩展统一 Job：

```ts
type JobKind = "exec" | "read-file" | "write-file";
```

Job 根据 `kind` 携带经过验证的结构化 payload；Storage 仍作为独立服务。不要把文件操作伪装成 shell command，否则路径验证、能力检查和结果类型都难以保证。

### 2. Socket.IO 是否传文件本体？

**不传。**

Socket.IO 属于控制面，只传：

- Job 创建、下发、取消和状态变化
- 远程路径等小型结构化参数
- `FileRef`
- 上传完成通知
- 文件 ID、字节数、摘要、错误码等 metadata
- 命令 stdout/stderr 文本流

文件本体属于数据面，通过：

- Storage HTTP `GET` / `PUT`
- S3/OSS 等对象存储的预签名 URL
- Local Storage 对应的受控 HTTP endpoint

即使使用 Local Storage，文件可以流经 Server 的 HTTP endpoint，但也不应包装进 Socket.IO 事件。

### 3. 控制面与数据面如何划分？

#### 控制面：REST + Socket.IO

职责：

- REST 创建文件操作 Job、查询状态、请求 FileRef。
- Socket.IO 向 Client 下发文件操作。
- Socket.IO 上报进度、完成、失败和取消结果。
- Server 校验 Client capability，例如注册信息中的 `"file"`。
- Job 记录“谁、在哪台机器、对哪个路径、执行了什么操作”。

#### 数据面：Storage HTTP

职责：

- Client 或 Frontend 使用 `FileRef.url` 直接上传/下载。
- 使用短期有效、操作受限的 GET/PUT URL。
- 流式传输文件，避免整文件进入内存。
- 校验大小、摘要和上传完成状态。
- Local/S3/OSS 驱动隐藏在 Storage Service 后面。

推荐流程：

**从 Client 读取文件：**

```text
Frontend -> Server: 创建 read-file Job
Server -> Storage: 创建 PUT FileRef
Server -> Client: dispatch { path, uploadRef }
Client -> Storage: HTTP PUT 文件本体
Client -> Server: job done { fileId, size, digest }
Server -> Frontend: GET FileRef
Frontend -> Storage: HTTP GET
```

**向 Client 写入文件：**

```text
Frontend -> Server: 请求 PUT FileRef
Frontend -> Storage: HTTP PUT 源文件
Frontend -> Server: 创建 write-file Job { fileId, targetPath }
Server -> Client: dispatch { targetPath, downloadRef }
Client -> Storage: HTTP GET
Client: 临时文件写入、校验、原子替换
Client -> Server: job done
```

---

## 当前实现离设计还缺什么

### [高] Storage/File 服务完全缺失

当前 `packages/server/src/` 只有 client、events、job、prisma 等模块，没有 `file` 或 `storage` 模块。尚缺：

- Storage Service 抽象
- Local FS 驱动
- GET/PUT HTTP endpoint 或预签名 URL
- FileRef 签发和过期校验
- 上传完成/失败确认
- 文件对象清理策略

这与 `docs/tech-stack.md:43` 规划的 `file` 模块尚未对齐。

### [高] Client 没有文件数据面实现

当前 Client 只有命令执行、注册和心跳代码，没有：

- `read-file` / `write-file` handler
- HTTP GET/PUT 流式传输
- 路径边界和 capability 校验
- 临时文件、原子替换
- 大小、摘要和磁盘空间校验
- 上传/下载失败后的安全错误上报

### [高] Job 模型只能表达命令执行

`packages/shared/src/index.ts:53-57` 的 `JobDispatch` 只有：

- `jobId`
- `command`
- `timeout`

`packages/server/prisma/schema.prisma:26-39` 的 `Job` 同样只有 `command`、`output`、`exitCode` 等命令执行字段。尚不能区分：

- exec Job
- read-file Job
- write-file Job
- 其他未来远程操作

最小必要扩展是 Job kind、经过验证的结构化 payload，以及结构化 result/file ID；不需要把 Storage 对象本体塞进 Job 表。

### [高] 文件 Job 无法返回 FileRef 结果

`packages/shared/src/index.ts:64-67` 的 `JobDone` 只有 `jobId` 和 `exitCode`；`JobInfo` 也只有字符串 `output`。§7 所需的 `localPath` 或更合理的 `fileId/FileRef` 均无协议位置。

需要补充结构化结果，或者单独定义文件 Job 完成 payload。不能依赖 stdout 中输出 JSON，因为这会把业务协议与命令文本混在一起。

### [中] FileRef 只是类型占位

`packages/shared/src/index.ts:142-149` 明确标注 `FileRef (reserved, not implemented)`。当前接口包含 `id/url/method/expiresAt/headers`，可以描述一次 GET 或 PUT，但仍未明确：

- PUT 完成后如何确认对象可用
- 上传 FileRef 与后续 GET FileRef 是否复用同一 `id`
- 文件大小、摘要、内容类型
- 对象所有权及 Client/Job 绑定
- URL 过期后的重新签发
- 删除和临时对象清理

这些不一定都要加入 `FileRef`，但必须由 Storage API 契约覆盖。

### [中] 事件设计尚不闭合

`docs/server-client-interaction-design.md` §7 使用 `job:read-file`，但：

- §8「事件汇总」没有该事件。
- `packages/shared/src/index.ts:4-16` 的 `Events` 没有任何文件事件。
- 没有 read/write payload、进度或结果类型。

在实现前应确定采用“统一 `job:dispatch + kind/payload`”还是独立事件。前者更复用现有 Job 生命周期，改动更小。

### [中] README 存在能力状态漂移

`README.md:42`、`:91`、`:105` 把“改文件”“文件读写”写成 VCPDeck 当前能力或功能边界，而核心规格又明确本轮没有实现 FileRef。建议后续在 README 标注“规划中”或区分“产品边界”与“当前已实现”，避免使用者误判。

### [中] 文件安全契约尚未定义

在直接文件操作上线前，至少需要明确：

- 是否允许绝对路径、`..`、符号链接/junction
- Client 可读写根目录
- 覆盖行为与原子写入
- 最大文件大小、超时和磁盘空间
- URL 作用域、有效期和一次性语义
- 日志不得输出 URL 中的签名、文件内容或敏感路径
- Client 不能接受任意外部 URL，以免形成 SSRF 能力

`docs/server-client-interaction-design.md` §9 只把 Storage 驱动接口列为后续设计，尚未覆盖这些信任边界。

---

## Residual risks

- 本次是只读静态审阅，没有运行端到端测试。
- 工作树在审阅前已有未提交修改，包括 `packages/shared/src/index.ts` 和 `packages/client/src/index.ts`；检查到的差异仅为格式调整，但本报告依据当前工作树内容，不保证与 `main` 完全相同。
- §7 只是概要设计；在明确 FileRef 生命周期、路径策略和上传完成语义前，不宜直接开始实现文件数据面。