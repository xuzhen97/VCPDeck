# Job 模型兼容 Client 文件管理与 Pi Agent 的设计建议

> 状态：建议稿
>
> 适用范围：VCPDeck Server、Client、Shared 协议，以及后续 Storage/File、
> Pi Agent 与审计模块
>
> 依据：当前代码实现、
> [`server-client-interaction-design.md`](./server-client-interaction-design.md)
> 与 Pi SDK/Session 文档

## 1. 结论

当前 Job 模型对后续 Client 文件管理和 Pi Agent 都是**生命周期兼容、数据模型不兼容**。

可以继续复用：

- Job ID 与目标 `clientId`
- `pending / running / done / error / disconnected / cancelled` 状态机
- 每个 Client 的排队与并发控制
- 超时、取消、断线与重连核对
- Job 查询与状态广播
- 以 `jobId` 作为远程操作的统一审计入口

不能直接复用：

- 仅包含 `command` 的创建与下发协议
- 通过 Shell 执行所有操作的 Client executor
- 只用 stdout、stderr、`exitCode` 表达结果的模型
- 把所有输出拼接到数据库 `output` 字符串的持久化方式
- 将一次 Pi Session、每次 Tool Call 或终端连接直接等同于 Job

建议采用：

> **Job 是 VCPDeck 统一的远程执行与审计信封；Typed Job 描述不同操作；
> Storage + FileRef 负责文件字节；AgentRun、JobEvent、Pi Session 和
> Artifact 记录 Pi Agent 的执行证据。**

不要新建脱离 Job 生命周期的 FileTask 或 AgentTask 状态机，也不要把
正式文件管理和 Pi Agent 简单实现为不可观测的 Shell 命令。

---

## 2. 当前实现判断

### 2.1 当前 Job 是命令执行记录

当前公共协议中的 `JobCreate`、`JobDispatch` 和 `DispatchPayload` 都以 `command: string` 为核心，见：

- `packages/shared/src/index.ts`
- `packages/server/src/job/job.service.ts`
- `packages/server/src/job/job.scheduler.ts`
- `packages/server/src/events/events.gateway.ts`

数据库 `Job` 模型同样只有命令执行语义：

- `command`
- `status`
- `exitCode`
- `output`
- `timeout`

见 `packages/server/prisma/schema.prisma`。

Client 收到 Job 后固定执行：

```ts
spawn(job.command, {
  shell: true,
  timeout: job.timeout,
});
```

见 `packages/client/src/executor.ts`。因此当前 Job 的真实含义是：

> 在指定 Client 上通过系统 Shell 执行一段字符串命令，并收集文本输出和退出码。

它目前还不是能够表达不同远程操作的通用任务模型。

### 2.2 当前文件能力只是预留

`packages/shared/src/index.ts` 已定义 `FileRef`：

```ts
export interface FileRef {
  id: string;
  url: string;
  method: "GET" | "PUT";
  expiresAt: number;
  headers?: Record<string, string>;
}
```

但当前尚无：

- Storage/File Server 模块
- FileRef 签发与过期校验
- GET/PUT 数据端点
- Client 文件操作 handler
- Client HTTP 流式上传和下载
- 文件元数据、摘要和结构化结果

Client 注册信息也只声明 `capabilities: ["exec"]`，说明当前实际能力仍限于命令执行。

---

## 3. 文件操作兼容性

| 操作 | 直接使用当前 command Job | Typed Job | 独立文件数据通道 |
| --- | --- | --- | --- |
| 列目录 `list` | 仅适合临时原型 | 适合 | 不需要 |
| 获取元数据 `stat` | 仅适合临时原型 | 适合 | 不需要 |
| 创建目录 `mkdir` | 不推荐 | 适合 | 不需要 |
| 小文本读取 `readText` | 不推荐 | 适合 | 通常不需要 |
| 小文本写入 `writeText` | 不推荐 | 适合 | 通常不需要 |
| 删除 `delete` | 风险高 | 适合 | 不需要 |
| 移动/重命名 `move` | 风险高 | 适合 | 不需要 |
| 上传到 Client | 不兼容 | 负责控制与状态 | 必须 |
| 从 Client 下载 | 不兼容 | 负责控制与状态 | 必须 |
| 大文件读写 | 不兼容 | 负责控制与状态 | 必须 |
| 跨 Client 复制/移动 | 不兼容 | 编排多个 Job | 必须 |

### 3.1 不应依赖 Shell 的原因

将文件路径或内容拼入 `command` 会带来：

1. **跨平台差异**：Windows 与 Linux 的 `dir/ls`、`del/rm`、`move/mv` 语义和输出不同。
2. **命令注入风险**：引号、换行、管道、通配符和 Shell 元字符可能改变命令含义。
3. **结果不稳定**：系统语言、时间格式和终端编码会影响目录输出解析。
4. **错误语义不足**：`exitCode` 无法稳定表达路径不存在、越权、冲突、空间不足等领域错误。
5. **难以验证**：调用方必须了解 Shell 与目标系统细节，模块接口过浅。

正式文件操作应由 Client 使用 Node.js 标准库 `node:fs/promises` 和流式接口实现，不生成 Shell 命令。

### 3.2 文件本体不能进入 Job output

当前 Client 将 stdout/stderr 的 `Buffer` 转为字符串，Server 再将文本追加到 Job 的 `output` 字段。这不适合文件传输，因为：

- 二进制内容会损坏
- Base64 会增加体积
- 大文件会占用 Socket.IO、Server 内存和数据库空间
- 当前协议没有背压、摘要校验和断点语义
- Job 历史会意外长期保存敏感文件内容

因此，文件字节不能通过 `job:stdout`、`job:stderr` 或 `job:done` 传输。

---

## 4. 推荐的职责划分

### 4.1 Job：控制面

Job 负责：

- 指定目标 Client
- 描述文件操作类型和小型结构化参数
- 排队、并发和状态变化
- 超时、取消和断线处理
- 保存结构化结果或文件引用
- 为审计记录“在哪台机器的哪个路径执行了什么操作”

Job 不负责：

- 保存文件本体
- 传输文件分片
- 管理对象存储驱动
- 长期保存带签名的下载/上传 URL

### 4.2 Storage/File：数据面

Storage/File 模块负责：

- 创建受限、短期有效的 GET/PUT FileRef
- 流式接收和发送文件
- 保存文件对象及元数据
- 校验文件大小和摘要
- 管理临时对象、过期对象与清理策略
- 隐藏 Local FS、S3、OSS 等具体存储实现

### 4.3 Client 文件执行器

Client 根据 Job 类型分派到不同 handler：

```text
exec          -> 当前 Shell executor
file.list     -> fs.readdir
file.stat     -> fs.stat / fs.lstat
file.readText -> fs.readFile（限制大小）
file.writeText-> 临时文件 + rename
file.mkdir    -> fs.mkdir
file.delete   -> fs.rm
file.move     -> fs.rename
file.download -> 文件流 -> Storage HTTP PUT
file.upload   -> Storage HTTP GET -> 临时文件 -> rename
```

首版不需要 factory、工作流引擎或每种操作单独建表；一个有类型的 dispatcher 足够。

---

## 5. 建议的 Job 协议演进

### 5.1 使用判别联合

建议将 Job 从单一命令扩展为 Typed Job，同时保留现有命令兼容性：

```ts
type JobDispatch =
  | {
      jobId: string;
      type: "exec";
      command: string;
      timeout?: number;
    }
  | {
      jobId: string;
      type: "file.list";
      path: string;
      timeout?: number;
    }
  | {
      jobId: string;
      type: "file.delete";
      path: string;
      recursive?: boolean;
      timeout?: number;
    }
  | {
      jobId: string;
      type: "file.download";
      path: string;
      uploadRef: FileRef;
      timeout?: number;
    }
  | {
      jobId: string;
      type: "file.upload";
      path: string;
      downloadRef: FileRef;
      timeout?: number;
    };
```

这里的命名约定是：

- `file.download`：从 Client 取出文件，Client 向 Storage 上传
- `file.upload`：向 Client 放入文件，Client 从 Storage 下载

实现时也可以采用更不易混淆的 `file.export` / `file.import`，但整个 Shared、Server、Client 必须统一。

### 5.2 增加结构化结果

文件 Job 不应把 JSON 打印到 stdout。完成消息应允许结构化结果和稳定错误：

```ts
type JobResult =
  | { type: "exec"; exitCode: number }
  | { type: "file.list"; entries: FileEntry[] }
  | { type: "file.transfer"; fileId: string; size: number; sha256: string }
  | { type: "file.change"; path: string };

interface JobError {
  code: string;
  message: string;
}
```

错误 `message` 必须安全，不泄露文件内容、签名 URL、密钥或 stack。

### 5.3 数据库存储建议

在现有 `Job` 表上最少增加：

- `type`：默认 `exec`
- `payload`：结构化输入的 JSON 文本
- `result`：结构化结果的 JSON 文本，可空
- `errorCode`：稳定错误码，可空
- `errorMessage`：安全错误信息，可空

迁移期间可保留现有 `command`、`output`、`exitCode`，并让它们只服务 `exec` Job。文件 Job 不应使用空命令字符串模拟类型。

首版无需为每一种文件操作建立独立数据库表。只有当文件对象需要独立生命周期、权限和清理策略时，才由 Storage/File 模块建立自己的持久化模型。

---

## 6. 推荐的数据流

### 6.1 从 Client 下载文件

```text
Frontend/Pi -> Server：创建 file.download Job { clientId, path }
Server -> Storage：创建受限 PUT FileRef
Server -> Client：dispatch { path, uploadRef }
Client -> Storage：HTTP PUT 文件流
Storage：校验大小/摘要并完成对象
Client -> Server：job done { fileId, size, sha256 }
Server -> Frontend/Pi：返回 Job 结果或签发 GET FileRef
Frontend/Pi -> Storage：HTTP GET 文件流
```

### 6.2 向 Client 上传文件

```text
Frontend/Pi -> Server：申请上传 FileRef
Frontend/Pi -> Storage：HTTP PUT 源文件
Frontend/Pi -> Server：创建 file.upload Job { clientId, targetPath, fileId }
Server -> Storage：为 Client 签发受限 GET FileRef
Server -> Client：dispatch { targetPath, downloadRef }
Client -> Storage：HTTP GET 到临时文件
Client：校验大小/摘要
Client：rename 原子替换目标文件
Client -> Server：job done { path, size, sha256 }
```

### 6.3 同一 Client 内移动文件

```text
Frontend/Pi -> Server：创建 file.move Job
Server -> Client：dispatch { source, destination, overwrite }
Client：校验路径与策略
Client：fs.rename
Client -> Server：结构化完成结果
```

跨 Client 的移动不是单机原子操作，应编排为：源 Client 下载、目标 Client
上传、确认成功后删除源文件。首版可以只支持复制，不承诺跨 Client 原子移动。

---

## 7. 对现有设计文档的修正建议

`docs/server-client-interaction-design.md` 的总体原则正确：

> Socket.IO 只传 FileRef，文件本体由 Client / Frontend 按照 FileRef 直接操作。

但其中“读取远程文件”的流程存在跨机器问题：Client 返回的 `localPath`
属于 Client 文件系统，Server 的 `Storage Service` 无法直接执行
`store(localPath)`。

应改为：

1. Server 先创建 PUT FileRef。
2. Server 将远程路径和 PUT FileRef 随 Job 下发。
3. Client 直接把文件流上传至 Storage。
4. Client 仅向 Server 报告对象 ID、大小、摘要和完成状态。
5. Server 再为 Frontend/Pi 签发 GET FileRef。

同时，文档中使用了 `job:read-file`，但事件汇总没有定义该事件。建议不要
为每种操作无限新增 Socket.IO 事件，而是继续使用统一 `job:dispatch`，通过
`type` 和结构化 payload 区分操作。

---

## 8. 上线文件写删前的安全要求

### 8.1 Socket 与 Job 归属校验

当前 Job stdout、stderr、done、cancelled 事件主要根据 payload 中的
`jobId` 更新数据库。文件能力上线前，Server 必须验证：

```text
当前 Socket 绑定的 clientId === Job.clientId
```

否则持有同一 PSK 的其他 Client 可能伪造任务结果，甚至影响文件写入或删除流程。

### 8.2 路径策略

必须明确并在 Client 信任边界执行：

- 允许访问的根目录
- 是否允许绝对路径
- `..` 处理
- Windows drive 和 UNC 路径策略
- symlink/junction 是否允许跳出根目录
- 覆盖、递归删除与 force 的默认行为

路径规范化后必须再次检查其是否仍位于允许根目录内。不能只做字符串前缀判断。

### 8.3 写入与替换

文件上传到 Client 时应：

1. 下载到目标目录内的临时文件。
2. 限制最大大小并检查剩余空间。
3. 校验声明大小与摘要。
4. 根据覆盖策略执行原子 rename。
5. 失败时删除临时文件，不破坏原文件。

### 8.4 FileRef 限权

FileRef 至少应满足：

- 短期有效
- 限定单一 GET 或 PUT 方法
- 与文件对象、Job 和调用主体绑定
- 可限制内容长度
- 过期后必须重新签发
- 签名 URL 和 headers 不写入普通日志或 Job output
- Client 不能接受任意外部 URL，避免形成 SSRF 能力

### 8.5 Capability 校验

Client 应声明实际支持的能力，例如：

```ts
capabilities: ["exec", "file.read", "file.write"]
```

Server 在创建和下发 Job 时必须检查 capability。只声明 `exec` 的旧 Client 不应收到文件 Job。

---

## 9. 断线、取消与幂等性

当前 Client 的活动 Job 只保存在进程内 `Map` 中。网络断线但进程仍运行时可以重连汇报；Client 进程重启后则无法恢复原任务状态。

文件操作需要按副作用强度分别处理：

- `list/stat/readText`：可安全重试。
- `mkdir`：使用可重复语义时可重试。
- `write/upload`：临时文件 + 原子 rename，并返回摘要用于核验。
- `move`：重试前检查 source 与 destination 的实际状态。
- `delete`：默认不自动盲目重试；先核验目标和操作 ID。
- 大文件传输：首版允许整次重试，不必提前实现断点续传。

取消文件 Job 时，Client 需要取消正在进行的 HTTP 请求、关闭文件流并清理临时文件，而不是调用进程 `kill`。

---

## 10. 分阶段落地建议

### 阶段一：Typed Job 基础

目标：在不实现文件本体传输的前提下，证明 Job 可以分派不同类型。

建议范围：

- 增加 `type/payload/result/error`
- 保持现有 `exec` 行为兼容
- Client 增加统一 typed dispatcher
- Server 校验 Socket 与 Job 归属
- Server 检查 Client capability

首批只实现低风险元数据操作：

- `file.list`
- `file.stat`

### 阶段二：受控的小型文件操作

建议增加：

- `file.readText`，设置明确大小和编码限制
- `file.writeText`，使用临时文件与原子替换
- `file.mkdir`
- `file.move`
- `file.delete`

写入、覆盖和递归删除必须显式传参，不使用危险默认值。

### 阶段三：Storage + FileRef

建议增加：

- 首个真实 Storage 实现，只做一个 Local Storage adapter
- 受限 GET/PUT endpoint
- Client 流式上传和下载
- 大小与 SHA-256 校验
- 临时对象和过期对象清理
- `file.download` 与 `file.upload`

在第二个存储后端出现之前，不需要提前建立复杂的驱动工厂或插件系统。

### 阶段四：按实际需求增强

仅在有明确需求或测量证据后再增加：

- 断点续传
- 传输进度事件
- 跨 Client 复制编排
- 同路径任务锁
- S3/OSS adapter
- 内容去重与版本管理

---

## 11. 验收标准

### Typed Job

- 旧 `exec` Job 行为保持不变。
- 旧 Client 不会收到不支持的文件 Job。
- 文件 Job 不经过 `spawn(..., { shell: true })`。
- 文件 Job 返回结构化结果和稳定错误码。
- Server 拒绝来自错误 Client Socket 的 Job 更新。

### 路径安全

- `..`、symlink/junction 和跨盘路径不能绕过允许根目录。
- 删除和覆盖必须由显式参数允许。
- 错误响应和日志不泄露文件内容、密钥、签名 URL 或 stack。

### 文件传输

- 文件本体不进入 Socket.IO Job 事件和 Job 数据库 output。
- 上传、下载均为流式处理，不整文件读入内存。
- 完成前校验大小和 SHA-256。
- 失败或取消后不留下半成品目标文件。
- FileRef 过期、方法错误或主体不匹配时访问失败。

### 断线与恢复

- 网络断线后仍在运行的任务可以在重连时核对状态。
- Client 进程重启后的未知副作用不会被直接标记为成功。
- 写入、移动和删除任务具有明确的重试或人工核验策略。

---

## 12. 明确不做

为保持当前阶段的实现简单，首版不建议：

- 新建独立于 Job 的 FileTask 状态机
- 将文件内容 Base64 后放进 Job output
- 为每种文件操作建立一套 Socket.IO 事件
- 为每种 Job 建独立数据库表
- 提前实现通用 workflow engine
- 提前实现多个 Storage adapter
- 在没有实际需求前实现断点续传和内容去重

当前文件管理最小且可持续的演进路径是：

```text
现有 exec Job
    -> Typed Job
    -> Client fs handler
    -> 单一 Local Storage + FileRef
    -> 按需求增加传输与存储能力
```

---

## 13. Client Pi Agent 的总体判断

在目标 Client 上运行 Pi Agent 时，继续使用 Job 系统是合理的，而且符合 VCPDeck“统一调度、统一审计、出现问题后可追溯和修复”的愿景。

但必须重新明确 Job 的领域含义：

> Job 是一次具有明确目标、目标 Client、权限、生命周期和结果的远程操作。

因此，以下都可以是 Typed Job：

```text
exec
file.list
file.upload
agent.run
deploy
diagnose
```

Pi Agent 是 `agent.run` Job 的一种执行器，而不是 Job 本身。Job 负责回答：

- 谁在什么时间、通过什么入口发起任务
- 为什么运行 Agent，初始目标是什么
- 调度到了哪台 Client、哪个项目和工作目录
- 使用了哪个 Pi 版本、模型和权限策略
- 运行经过了哪些阶段、工具和人工输入
- 修改了哪些文件，产生了哪些 diff、测试报告和 commit
- 为什么结束、失败或被取消
- 失败后由哪个新 Job 继续诊断或修复

这使 Job 能成为全链路日志和事故追溯的稳定索引，而不依赖 Pi 的内部实现细节。

---

## 14. 一次性与交互式 Agent Job

建议同一个 `agent.run` 类型支持两种模式：

```ts
type AgentJobMode = "one-shot" | "interactive";
```

### 14.1 一次性任务

适用场景：

- 自动诊断和修复代码
- 运行测试、构建或巡检
- 生成报告
- 自动部署前检查
- Workflow 中的无人值守步骤

示例 payload：

```json
{
  "type": "agent.run",
  "clientId": "client-a",
  "payload": {
    "mode": "one-shot",
    "cwd": "D:/VCPHub/VCPDeck",
    "prompt": "诊断失败测试并修复，完成后运行验证"
  }
}
```

建议结束语义：

```text
Pi 当前任务完成并进入 idle -> Job done
Pi 返回不可恢复错误       -> Job error
达到时间或资源限制         -> Job error/cancelled，并记录 stopReason
用户主动取消               -> Job cancelled
```

一次性 Job 可以包含多个 Pi Turn 和 Tool Call，但它们仍属于同一个目标，不应拆成多个 Job。

### 14.2 交互式任务

适用场景：

- 用户与 Pi 持续调查问题
- Agent 先分析，用户批准后再修改
- 用户中途补充信息或改变当前步骤
- 远程结对编程
- 从失败任务的证据继续调查

示例 payload：

```json
{
  "type": "agent.run",
  "clientId": "client-a",
  "payload": {
    "mode": "interactive",
    "cwd": "D:/VCPHub/VCPDeck",
    "prompt": "调查 Job 调度竞态，先分析，不要修改"
  }
}
```

Pi 完成当前回合时，交互式 Job 不应自动结束，而应等待后续输入。只有以下情况结束：

- 用户明确完成任务
- 用户取消任务
- 达到明确的空闲超时
- Client 或 Server 按策略关闭
- 策略明确允许 Agent 自动确认目标完成

首版建议由用户明确完成交互式 Job，避免 Agent 回答一次就错误关闭整个调查任务。

---

## 15. Job、AgentRun、Pi Session、JobEvent 与 Artifact

推荐关系：

```text
TODO / Workflow
  └── Job：一次可调度、可审计的目标
        ├── AgentRun：一次实际执行尝试
        │     └── Pi Session：Agent 上下文和消息树
        ├── JobEvent：追加式执行时间线
        ├── Artifact：Session、diff、日志和测试报告
        └── Attachment：终端或 Web UI 的临时连接
```

### 15.1 Job

Job 保存稳定的业务事实：

- 发起者和来源
- 目标 Client
- Job 类型和目标
- 项目、仓库和工作目录
- 权限与资源限制
- 调度和最终状态
- 父子 Job 与修复关系
- 最终摘要和结果引用

### 15.2 AgentRun

AgentRun 表示 Job 的一次实际执行尝试。一个 Job 可能因为断线、Worker 崩溃或显式重试产生多个 AgentRun，历史不能被覆盖。

最小字段建议：

```ts
interface AgentRun {
  id: string;
  jobId: string;
  attempt: number;
  clientId: string;
  sessionId: string | null;
  traceId: string;
  cwd: string;
  piVersion: string;
  provider: string;
  model: string;
  status: string;
  stopReason: string | null;
  startedAt: string;
  finishedAt: string | null;
}
```

首版可以只执行一次，但持久化模型不应假设一个 Job 永远只有一次尝试。

### 15.3 Pi Session

Pi Session 管理：

- 用户与 Agent 消息
- Tool Call 与 Tool Result
- 模型、token 和 cost
- 分支、fork 与 compaction
- Agent 的持续上下文

Pi Session 不应代替 Job，因为它不完整覆盖 Server 调度、Client 连接、授权、重试、Storage 和父子任务链路。

建议保存：

```text
AgentRun.sessionId
AgentRun.sessionArtifactId
```

不要只保存 Client 本地 Session 文件绝对路径。完整 Session JSONL 应作为受控 Artifact 上传，供审计、恢复或后续修复使用。

Compaction 只改变模型当前上下文，不应删除原始审计事件或原 Session JSONL。

### 15.4 JobEvent

Pi 的消息、Turn、Tool Call 和人工输入应成为同一个 Job 下的追加式事件，而不是分别创建 Job。

建议首批事件：

```text
job.dispatched
run.started
agent.started
user.message
assistant.message.completed
turn.started
tool.started
tool.completed
artifact.created
run.completed
run.failed
run.cancelled
```

只有当一个子操作需要独立 Client、调度、授权、取消或重试时，才创建子 Job，例如在另一台 Client 部署或执行集成测试。

### 15.5 Artifact

以下大内容不应直接塞进 Job 或 JobEvent：

- 完整 Pi Session JSONL
- 大型 stdout/stderr
- Git diff/patch
- 测试和构建报告
- 截图或诊断包
- Agent 生成的文件

它们应通过 Storage + FileRef 保存为 Artifact，并关联 `jobId` 和 `runId`。

---

## 16. 交互终端与 Attachment

终端连接只是用户访问 Agent Job 的临时 Attachment，不等于 Job，也不等于 Pi Session。

推荐关系：

```text
Agent Job
  └── Pi Session
        ├── CLI Terminal Attachment
        ├── Web Terminal Attachment
        └── Read-only Observer Attachment
```

应明确区分：

| 操作 | 语义 |
| --- | --- |
| `attach` | 连接并查看已有事件与实时输出 |
| `detach` | 离开界面，Job 和 Session 继续存在 |
| `abort turn` | 中止当前 Pi Turn，Session 仍可继续 |
| `cancel` | 终止 AgentRun，Job 进入 cancelled |
| `finish` | 用户确认目标完成，Job 进入 done |
| `close session` | Session 不再接受输入，但历史和 Artifact 保留 |

浏览器关闭、SSH 断开或网络中断默认只应触发 `detach`，不能隐式取消 Job。

### 16.1 推荐：结构化终端界面

首选方案是由 VCPDeck 渲染终端风格界面，但底层使用结构化协议：

```text
VCPDeck UI/CLI
  -> Server
  -> Client Agent Worker
  -> Pi SDK AgentSession
```

用户输入被映射为：

```text
prompt
steer
follow-up
abort
```

Pi SDK 事件再转换为 JobEvent。这样可以稳定区分用户消息、Agent 消息、工具调用和结果，也便于审计、脱敏、权限控制、Web/移动端复用和历史回放。

### 16.2 可选：原生 PTY

以后若确实需要完整 Pi TUI，可增加：

```text
xterm.js/Terminal
  -> WebSocket
  -> Client PTY
  -> Pi TUI
```

但 PTY 字节流包含 ANSI 控制字符，不能可靠表达消息、Tool Call 和审计语义。因此：

> PTY 只负责显示和输入，Pi SDK、extension 或 sidecar 产生的结构化事件仍是审计事实来源。

首版不建议同时实现 SDK 集成和跨平台 PTY。

---

## 17. Agent Job 状态与并发

交互式任务需要区分 Agent 正在执行和等待用户输入。建议在现有状态中增加：

```text
waiting_input
```

状态流：

```text
pending -> running -> done/error/cancelled
                    -> waiting_input -> running
                                     -> done/cancelled
```

语义：

- `running`：Agent 正在推理、执行工具或处理输入。
- `waiting_input`：当前回合结束，Session 仍可继续。
- `disconnected`：Client 不可达，Server 不能确认实际执行状态。

`waiting_input` 不应占用普通执行并发槽，否则少量等待用户的 Session 会阻塞一次性任务。建议分别限制：

```text
maxConcurrentAgentRuns
maxInteractiveSessions
interactiveIdleTimeout
```

首版可以延续当前调度器的简单模型：只让 `running` 计入执行并发，`waiting_input` 只计入 Session 数量。

---

## 18. Pi 集成方式

VCPDeck 与 Pi 都使用 Node.js/TypeScript，且审计需要结构化事件，因此推荐：

```text
VCPDeck Client 主进程
  └── Agent Worker 子进程
        └── Pi SDK AgentSession
```

推荐理由：

- Pi SDK 提供 `AgentSession`、持久化 `SessionManager` 和事件订阅。
- 可获得 Agent、Turn、Message、Tool、Retry 和 Compaction 生命周期。
- 可以调用 `prompt()`、`steer()`、`followUp()` 和 `abort()`。
- Worker 崩溃不会拖垮 Client 心跳和网关连接。
- 可以为 Worker 限制工作目录、工具、环境变量和资源。

不要把 `pi -p` 的 stdout 作为正式集成协议。它适合原型，但会丢失结构化 Tool Call、Session 和生命周期信息。

取消 Agent Job 时建议：

1. 调用 `session.abort()` 中止当前 Agent Turn。
2. 给 Worker 一个短暂清理窗口，刷新事件和 Session。
3. 超时后终止 Worker 子进程。
4. 保存取消事件和已有 Artifact。

Client capability 可增加：

```ts
capabilities: ["exec", "file.read", "file.write", "agent.pi"]
```

Server 创建和下发 `agent.run` 前必须检查 `agent.pi` 能力以及协议版本。

---

## 19. Agent 全链路审计

### 19.1 JobEvent 最小模型

建议使用追加式事件，而不是继续更新单个 `output` 字符串：

```ts
interface JobEvent {
  id: string;
  jobId: string;
  runId: string;
  sequence: number;
  type: string;
  timestamp: string;
  receivedAt: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  level: "debug" | "info" | "warn" | "error";
  payload?: unknown;
  artifactId?: string;
}
```

其中：

- `sequence` 恢复单个 Run 内的顺序。
- `timestamp` 是事件产生时间。
- `receivedAt` 是 Server 接收时间，用于识别时钟漂移和延迟。
- `traceId/spanId` 为以后接入 OpenTelemetry 保留稳定关联。
- 对 `(runId, sequence)` 建唯一约束，实现幂等补传。

### 19.2 实时流与持久化审计分离

Pi 会产生大量 text delta 和工具输出 delta。建议：

```text
实时体验：message.delta / tool.output.delta
持久化审计：message.completed / tool.started / tool.completed
大型内容：Artifact
```

不需要把每个 token delta 写入数据库。实时 delta 丢失后，完整消息、JobEvent 和 Session Artifact 仍应支持事后回放。

### 19.3 断线期间不能丢审计事件

现有“断线期间不缓冲输出”的策略不适用于 `agent.run`。建议 Client 为每个 AgentRun 建立本地事件 spool：

1. 事件按递增 `sequence` 追加到本地。
2. Client 向 Server 批量发送。
3. Server 持久化后确认最后收到的 sequence。
4. Client 只删除已确认事件。
5. 重连后从最后未确认位置继续补传。
6. Server 按 `(runId, sequence)` 去重。

这提供“至少一次传输 + 幂等去重”，不需要提前实现复杂的 exactly-once 系统。

### 19.4 人工输入必须审计

每次用户输入应记录：

```ts
interface AgentInputEvent {
  jobId: string;
  runId: string;
  sessionId: string;
  actorId: string;
  source: "web" | "terminal" | "api" | "workflow";
  mode: "prompt" | "steer" | "follow-up";
  content: string;
  timestamp: string;
}
```

否则事后无法判断问题来自初始目标、Agent 自主行为，还是用户中途改变方向或批准了危险操作。

---

## 20. 失败追溯与 Agent 修复链

失败后的修复不应覆盖原 Job。应创建新的关联 Job：

```text
job-100：原始任务，error
  └── job-101：第一次修复，error
        └── job-102：第二次修复，done
```

建议 Job 增加：

```text
rootJobId
parentJobId
causedByEventId
```

修复 Agent 应获得受控的证据包：

- 原始目标和人工输入
- 原 Job 的结构化时间线
- 失败 Tool Call、错误码和输出 Artifact
- Client OS、Pi 版本、模型和工具配置
- 仓库 remote、branch 和起始 commit SHA
- 原 Job 产生的 diff、commit 和测试结果
- 原 Pi Session JSONL 或其受控摘要

修复 Job 应从明确的代码基线开始，先复现失败，再修改、验证并保存新的
diff/commit。可以 fork 原 Pi Session，但必须创建新的 Job 和 AgentRun，
不能覆盖原 Session 或原审计记录。

---

## 21. Agent 审计的安全与隐私

应记录：

- 发起者、目标 Client、cwd、仓库和起始 commit
- Pi 版本、模型、thinking level、工具列表
- Tool Call 名称和脱敏参数
- 工具结果、exitCode、时长和错误码
- 修改文件列表、diff、测试和构建结果
- token、cost、stopReason、重试和取消时间

不应直接记录：

- API Key、OAuth Token 和 PSK
- `.env`、私钥和完整环境变量
- FileRef 签名 URL 和敏感 headers
- 未脱敏的命令参数
- 文件完整内容，除非作为有权限和保留期的 Artifact
- 模型隐藏思维过程

审计重点应是：Agent 收到什么、调用什么工具、修改什么、获得什么结果以及最终做出什么可观察行为，而不是依赖隐藏推理。

交互式 Agent 还应定义控制权：首版建议同一时间只有一个可写 Attachment，其他连接只读观察；控制权转移和审批留到有明确需求时增加。

---

## 22. Pi Agent 分阶段落地建议

### Agent 阶段一：一次性任务

实现：

- `agent.run + mode=one-shot`
- Agent Worker + Pi SDK
- 持久化 Pi Session
- 基础 AgentRun 和 JobEvent
- 最终消息、Session、patch 和测试报告 Artifact
- Client capability 与 Socket/Job 归属校验

### Agent 阶段二：结构化交互

增加：

- `mode=interactive`
- `waiting_input`
- `attach/detach`
- `prompt/steer/follow-up/abort turn`
- 历史事件回放
- 空闲 Session 限额与超时

### Agent 阶段三：可靠审计与修复

增加：

- Client 本地事件 spool 与 sequence 补传
- `rootJobId/parentJobId/causedByEventId`
- 修复 Job 的证据包
- Git 基线、diff、commit 和验证结果
- Artifact 权限、保留期和脱敏

### Agent 阶段四：按需求增强

仅在有明确需求后增加：

- 工具和危险操作审批
- 多用户控制权转移
- 原生 Pi TUI/PTY
- OpenTelemetry Collector
- 跨 Client 子 Job 编排
- 成本预算、Turn 限制和更复杂的恢复策略

---

## 23. Pi Agent 验收标准

### 一次性任务

- `agent.run` 不通过解析普通 stdout 获取结构化状态。
- Job 能查询到 Client、cwd、Pi Session、模型、开始/结束时间和最终结果。
- Tool Call 和 Tool Result 能按时间线回放。
- 代码修改、测试报告和 Session 以 Artifact 保存。
- 取消时先中止 Agent，再安全终止 Worker。

### 交互式任务

- 当前 Turn 结束后进入 `waiting_input`，不会自动关闭 Job。
- 用户可 detach 后重新 attach，并恢复历史和实时输出。
- 终端断开不取消 Job。
- 每次人工输入都记录 actor、来源、时间和输入模式。
- `waiting_input` 不占用 Agent 执行并发槽。

### 审计与恢复

- 每个事件可通过 `jobId/runId/traceId` 关联。
- Client 断线后可按 sequence 补传且 Server 能幂等去重。
- Pi Session compaction 不删除原始审计证据。
- 原 Job、失败 Job 和修复 Job 的因果关系可查询。
- 敏感凭据、签名 URL 和隐藏思维不会进入普通日志。

---

## 24. 统一演进路径

最终建议的最小演进顺序：

```text
现有 command Job
  -> Typed Job：exec / file.* / agent.run
  -> JobEvent + Artifact
  -> 文件管理：Client fs handler + Storage/FileRef
  -> Pi 一次性任务：Agent Worker + Pi SDK
  -> Pi 结构化交互：Session + waiting_input + Attachment
  -> 可靠事件补传与失败修复链
  -> 有需求后再接 PTY、审批和 OpenTelemetry
```

核心原则：

> **Job 管目标、调度和审计；AgentRun 管一次执行；Pi Session 管上下文；
> JobEvent 管时间线；Artifact 管大证据；Attachment 管临时交互。**

这样，一次性 Pi 任务、终端交互、文件操作和后续自动修复可以共享同一套
Job 主线，同时保持各模块职责清晰。
