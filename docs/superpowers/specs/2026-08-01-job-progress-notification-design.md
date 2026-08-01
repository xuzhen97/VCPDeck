# 导出进度与全局任务铃铛 — 设计文档

日期：2026-08-01
状态：已确认

## 背景

大文件导出（`file.export`）耗时数分钟，当前没有任何进度反馈：

- 文件面板点击"导出下载"后只有"导出中…"文字，无百分比/字节数
- 切到其他页面后完全看不到导出状态
- 导出完成后的下载是静默触发的，失败也无提示

用户需求：导出过程有**进度**（百分比 + 已传/总字节），右上角有**全局铃铛**统一展示任务进度，完成后可直接点击下载；文件列表内保留轻量就地提示。

## 方案选型

- **进度范围**：只报"远程机器 → Server"传输段进度（A 方案）。该段是大文件导出的主瓶颈；Server → 阿里云盘分片上传段本期不报（B 方案否决，改动翻倍收益低）。
- **通知形态**：全局铃铛（用户提出 + 确认）。等待型任务应归属全局，文件面板内不做第二套进度轮询，只保留轻量就地状态。

## 设计

### 1. shared：进度类型与事件

- 新增 `JobProgress { loaded: number; total: number }`
- `JobInfo` 增加 `progress: JobProgress | null`
- 新增事件常量 `JOB_PROGRESS`（WebSocket Client → Server）

### 2. client：传输段进度上报

`packages/client/src/transfer-handler.ts` 的 `handleExport`：

- 上传流 `data` 事件计数已读字节
- 节流上报（每 500ms 或每 1MB 变化，取先到者）经 WebSocket emit `JOB_PROGRESS { jobId, loaded, total }`
- `total` = `fileStat.size`（导出前已 stat）
- job 结束后停止上报（上传完成即 emitDone，无残余事件）

### 3. server：进度存储与透出

- `client.gateway` 处理 `JOB_PROGRESS` → 更新 job 表 `progress` 字段（JSON 字符串 `{loaded,total}`）
- `job.service.toJobInfo` 解析并返回 `progress`（`null` 当无）
- DB 写入节流：client 已按 500ms 节流，直接写即可（SQLite 单写频率可接受）

### 4. 前端：全局铃铛

新增 `packages/frontend/src/components/notification-bell.tsx`，挂在 App 布局右上角：

- **轮询**：每 3 秒 `sdk.jobs.list({ pageSize: 5 })`，与上次快照对比
- **进行中**：`pending/running` 的任务，渲染任务图标 + 文件名 + 进度条（`progress` 有值时显示 `已传 x / y MB · N%`，无值时仅"进行中"）
- **新完成**：上次非 done、本次 done 的 `file.export` → 进入"已完成"区，显示"导出完成：<文件名>" + **下载按钮**（`createDownloadToken({key, ttlSeconds: 0})` + anchor 下载，与详情页一致）；其他类型只显示完成状态
- **新失败**：进入"失败"区，显示错误码/信息
- **徽标**：进行中数量；无活动时不显示红点
- **清除**：完成/失败项可单独清除（会话内存态，刷新即清）
- 铃铛面板内不做下载进度提示（浏览器下载无法 JS 感知），下载点击后提示"已开始下载"

### 5. 前端：文件面板就地提示（轻量）

- `files-panel.tsx` 右键菜单导出：失败时红字提示（已有），成功下载触发时显示"正在开始下载…"短暂提示
- `file-detail.tsx` 查看器导出按钮：导出中显示"导出中…"（已有 busy 态保留），失败红字（已有）
- 不做就地百分比（全局铃铛承担）

## 不做的事

- Server → 阿里云盘分片上传段进度（B 方案）
- 浏览器下载阶段进度（`<a download>` 无法感知）
- 通知持久化（刷新即清）、声音/桌面推送
- 非 file.export 任务（exec/import 等）的进度上报——铃铛仅展示状态，进度条仅 file.export 有

## 验证

- 单元测试：
  - client：`handleExport` 流式上传时按节流 emit `JOB_PROGRESS`（fake 计时器控制 500ms 节流），结束后无残余上报
  - server：gateway 收到 `JOB_PROGRESS` 后 job 记录 progress 更新；`toJobInfo` 返回解析后的 `progress`
  - frontend：铃铛组件轮询渲染进行中进度条、新完成项出现下载按钮、失败项显示错误、清除交互
- 端到端（真实环境，用户 dev server）：执行大文件导出 → 铃铛出现进度条递增 → 完成后出现下载按钮 → 点击下载成功；文件面板导出失败路径显示红字
