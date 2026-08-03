# 导出进度与存储收尾状态设计

## 背景

`file.export` 当前上报的 `progress.loaded === progress.total` 只表示远程 Client 已经把文件请求体发送完。Server 还可能继续接收流、写入临时文件、上传阿里云盘分片、完成云盘上传并持久化真实 key，之后 Job 才会进入 `done`。铃铛因此会显示 100%，但下载按钮要等待较长时间才出现。

## 目标

- 让铃铛区分“远程上传完成”和“整个导出任务完成”。
- 保持进度数值只表示 Client → Server 传输段，不伪造云盘或浏览器下载百分比。
- 浏览器下载仍在 Job 完成后触发，不纳入任务进度。
- Server 重启导致内存上传缓存丢失时，从 File 表恢复完整元数据。

## 方案

### 前端铃铛

`NotificationBell` 的进行中 `file.export` 分两种显示：

- `loaded < total`：显示 `已传 x / y MB · N%`。
- `loaded >= total` 且 Job 仍为 `running`：显示 `上传完成 · 正在保存到云盘…`，使用收尾中的视觉状态，不显示任务已完成。
- Job 真正进入 `done` 后移入完成区，显示下载按钮。

不修改轮询机制，不增加 WebSocket，也不统计浏览器下载阶段。

### Server 上传兜底

`StorageService.receiveUpload()` 在 `pendingUploads` 没有记录时：

1. 按临时上传 key 查询 `File` 表。
2. 找到记录时使用其中的 `jobId`、`clientId`、`filename`、`mimeType`、`size` 作为 provider 元数据。
3. Provider 返回真实 key 后，继续执行现有的 File 临时 key → 真实 key 更新和 completed 状态持久化。
4. File 表也找不到时，保留当前从 key 推断文件名的最终兜底，并记录警告。

这样 Server 重启不会把有效文件降级成 `size: 0` 的元数据。

## 数据流

```text
Client 读取文件
  └─ JOB_PROGRESS: loaded/total ──> Job.progress
                                      │
                                      ├─ loaded < total
                                      │    铃铛：上传中 + 百分比
                                      │
                                      └─ loaded === total，Job 仍 running
                                           铃铛：上传完成，正在保存到云盘…

Server 接收流 → 云盘上传 → File/Job 持久化 → Job done
  └─ 铃铛：完成 + 下载按钮
```

## 错误处理

- Client → Server 上传失败：维持现有 Job error 流程。
- 云盘上传失败：维持现有 Job error 流程，不显示下载按钮。
- pending 缓存丢失但 File 记录存在：静默恢复元数据，不使用不完整 fallback。
- pending 缓存和 File 记录都不存在：维持最终兜底行为并保留警告。

## 测试

- 前端：进度未完成时显示百分比；进度达到 total 但任务仍 running 时显示云盘保存中提示；完成任务仍显示下载按钮。
- Server：pending 缓存丢失时按临时 key 从 File 表恢复元数据；File 表也不存在时仍能完成最终兜底。
- 回归：Frontend、Server、Client 测试和构建全部通过。
