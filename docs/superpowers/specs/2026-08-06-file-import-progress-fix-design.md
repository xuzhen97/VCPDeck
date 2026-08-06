# 阿里云盘文件导入与双阶段进度修复设计

## 背景与根因

文件导入包含两段数据传输：

1. 浏览器将本地文件分片上传到阿里云盘。
2. Client 从阿里云盘下载文件并写入远程机器。

现有浏览器实现以 3 个 worker 并发 PUT 分片。真实阿里云盘复现显示，OpenAPI 创建的上传会话要求顺序分片；并发上传时后续分片返回：

```text
HTTP 400
Code: PartNotSequential
Message: For sequential multipart upload, you must upload or complete parts ...
```

XHR 的上传进度事件可能先达到 100%，然后才收到 HTTP 400，因此界面会短暂显示 100%，但阿里云最终文件并不完整。失败任务实测只下载到 `134217728` 字节，而期望为 `157256198` 字节。

## 目标

- 浏览器严格按 `partNumber` 顺序上传阿里云分片。
- 文件页和任务通知分别显示：
  1. 上传到阿里云盘；
  2. 正在保存到阿里云盘；
  3. 导入远程机器。
- 两段传输各自从 0% 到 100%，第一段完成后不能沿用 100% 冒充第二段进度。
- 保持现有 REST、WebSocket、Client 下载和错误处理机制，不增加依赖，不让文件经过 Server 代理。

## 数据流

### 第一阶段：浏览器 → 阿里云盘

- `uploadDirect()` 按 `partNumber` 排序后逐片 PUT。
- 每片继续使用 XHR `upload.onprogress`，汇总为第一阶段 `loaded / total`。
- 仅当当前分片收到 2xx 后才上传下一片。
- 403 继续刷新该分片 URL 并重试；其他失败沿用现有有限重试。

### 云盘完成阶段

- 所有分片 2xx 后，文件页进入 `finalizing` 状态。
- 文案为“正在保存到阿里云盘…”，显示已完成的进度条，但不宣称导入完成。
- Server 调用阿里云 `openFile/complete`；失败时保留安全错误信息，并允许用户重新发起导入。

### 第二阶段：阿里云盘 → 远程机器

- Server 完成云盘上传后，将 Job 改为 `pending` 前把 `progress` 重置为 `{ loaded: 0, total: file.size }`。
- Client 保持现有流式下载、临时文件写入和 `JOB_PROGRESS` 上报。
- 文件页 `jobs.wait(... onUpdate)` 和通知铃铛根据 `running file.import` 显示“正在导入远程机器”。
- Client 完成大小校验和原子重命名后，Job 才进入 `done`。

## UI 状态

文件页上传状态扩展为：

- `uploading`：上传到阿里云盘，显示第一阶段百分比。
- `finalizing`：正在保存到阿里云盘，显示完成条/等待状态。
- `importing`：导入远程机器，显示第二阶段百分比。
- `done`：导入完成。
- `error`：显示实际失败信息。

通知铃铛按 Job 状态区分：

- `waiting_input`：上传到阿里云盘。
- `pending`：等待远程机器接收。
- `running file.import`：导入远程机器。

## 错误处理

- 分片 HTTP 非 2xx：停止后续分片并显示具体分片与 HTTP 状态。
- 云盘完成接口失败：Job 保持 `waiting_input`，错误返回文件页；不派发不完整文件。
- Client 下载大小不匹配：保持现有 `IO_ERROR`，删除临时文件，不覆盖目标文件。
- 目标冲突：保持现有确认覆盖流程。

## 测试

1. 前端 API：三个分片必须按 1 → 2 → 3 顺序启动，前一片成功前不得创建下一片 XHR。
2. 前端文件页：上传完成后先显示云盘保存状态，再将导入进度从 0 开始更新。
3. Server：激活 `file.import` 前重置 Job 进度为 `0 / total`。
4. 通知铃铛：`waiting_input`、`pending`、`running file.import` 使用正确阶段文案和进度。
5. Client：保留现有下载进度、大小校验和临时文件清理测试。
6. 运行 Frontend、Server、Client 定向测试及三端构建。

## 非目标

- 不实现断点续传。
- 不增加 Server 数据代理。
- 不增加上传并发配置。
- 不修改阿里云目录策略或持久化模型。
