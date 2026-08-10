# 设计：Pi 会话任务「标记完成」操作

日期：2026-08-10 · 状态：已确认

## 背景

任务列表页（`/jobs`）与任务详情页当前对 Pi 会话（`agent.session`）任务没有任何操作入口；只有 exec 任务在 pending/running 时有「取消任务」。用户需要能在列表与详情中把 Pi 会话任务标记为已完成。

## 后端依赖（零改动）

现有接口 `POST /api/clients/:clientId/pi/agent/:sessionId/complete`（SDK：`sdk.pi.complete(clientId, sessionId, runId?)`）已覆盖全部目标状态转换：

- 会话 job 的 `jobId` 即 `sessionId`，`clientId` 在 job 上，无需额外解析
- 不传 runId 时后端自动取当前 runId；`running`/`waiting_input` 会先发送 `agent.abort` 中止当前回合
- `idle` / `error`（空 payload）会话原子转为 `done` 并清理错误字段；`done` 幂等
- `cancelled` 状态不支持转 `done`

## 改动

### 1. 新组件 `packages/frontend/src/components/mark-done-button.tsx`

- Props：`{ job: JobInfo; onChanged: () => void; stopPropagation?: boolean; size?: "sm" | "default" }`
- 渲染条件：`job.type === "agent.session"` 且状态不在 `done` / `cancelled`
- 点击弹出确认框（复用 `ui/dialog`），文案：「标记任务为已完成？——若回合仍在运行，将先中止当前回合」
- 确认后调用 `sdk.pi.complete(job.clientId, job.jobId)`（不传 runId）
- 请求中按钮转 pending 并禁用；失败时对话框保持打开，红字显示 `error.message`；成功后关闭对话框并调用 `onChanged()`

### 2. 列表页 `packages/frontend/src/pages/jobs-page.tsx`

- 行内操作列新增 `<MarkDoneButton job={job} onChanged={onChanged} stopPropagation size="sm" />`，排在「取消任务」旁
- 抽屉详情 `JobDetails` 新增按钮；`JobsPage` 传入的 `onChanged` 同时刷新列表并 `sdk.jobs.get(jobId)` 回填抽屉内容，避免抽屉显示过期状态

### 3. 详情页 `packages/frontend/src/pages/job-detail-page.tsx`

- 按钮放 `PageHeading` 的 `actions` 区；完成后 `resource.reload()`

### 4. 测试

- 一个组件测试（vitest，沿用现有 setup）：非 `agent.session` / `done` / `cancelled` 不渲染；点击确认后调用 `sdk.pi.complete` 并触发 `onChanged`

## 不做的事

- 不改后端（接口已覆盖）
- 不处理 `agent.run` 遗留类型
- 不加 toast 系统；错误沿用对话框内红字
