# Job 模型兼容 Client 文件管理的设计建议

> 状态：建议稿  
> 适用范围：VCPDeck Server、Client、Shared 协议与后续 Storage/File 模块  
> 依据：当前代码实现与 [`server-client-interaction-design.md`](./server-client-interaction-design.md)

## 1. 结论

当前 Job 模型对后续 Client 文件管理是**生命周期兼容、数据模型不兼容**。

可以继续复用：

- Job ID 与目标 `clientId`
- `pending / running / done / error / disconnected / cancelled` 状态机
- 每个 Client 的排队与并发控制
- 超时、取消、断线与重连核对
- Job 查询与状态广播

不能直接复用：

- 仅包含 `command` 的创建与下发协议
- 通过 Shell 执行所有操作的 Client executor
- 只用 stdout、stderr、`exitCode` 表达结果的模型
- 把所有输出拼接到数据库 `output` 字符串的持久化方式

建议采用：

> **Typed Job 负责远程文件操作的控制面，Storage + FileRef 负责文件字节的数据面。**

不要新建一套脱离 Job 生命周期的 FileTask 系统，也不要把正式文件管理实现为拼接 Shell 命令。

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
|---|---|---|---|
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

跨 Client 的移动不是单机原子操作，应编排为：源 Client 下载、目标 Client 上传、确认成功后删除源文件。首版可以只支持复制，不承诺跨 Client 原子移动。

---

## 7. 对现有设计文档的修正建议

`docs/server-client-interaction-design.md` 的总体原则正确：

> Socket.IO 只传 FileRef，文件本体由 Client / Frontend 按照 FileRef 直接操作。

但其中“读取远程文件”的流程存在跨机器问题：Client 返回的 `localPath` 属于 Client 文件系统，Server 的 `Storage Service` 无法直接执行 `store(localPath)`。

应改为：

1. Server 先创建 PUT FileRef。
2. Server 将远程路径和 PUT FileRef 随 Job 下发。
3. Client 直接把文件流上传至 Storage。
4. Client 仅向 Server 报告对象 ID、大小、摘要和完成状态。
5. Server 再为 Frontend/Pi 签发 GET FileRef。

同时，文档中使用了 `job:read-file`，但事件汇总没有定义该事件。建议不要为每种操作无限新增 Socket.IO 事件，而是继续使用统一 `job:dispatch`，通过 `type` 和结构化 payload 区分操作。

---

## 8. 上线文件写删前的安全要求

### 8.1 Socket 与 Job 归属校验

当前 Job stdout、stderr、done、cancelled 事件主要根据 payload 中的 `jobId` 更新数据库。文件能力上线前，Server 必须验证：

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

当前最小且可持续的演进路径是：

```text
现有 exec Job
    -> Typed Job
    -> Client fs handler
    -> 单一 Local Storage + FileRef
    -> 按需求增加传输与存储能力
```
