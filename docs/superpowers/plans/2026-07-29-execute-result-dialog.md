# 远程执行结果弹框实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将机器执行页的右侧结果卡片改为提交后立即出现、执行中带动画、完成后原位展示结果的无障碍弹框。

**Architecture:** 保留 `useJobAction` 作为唯一任务状态来源；`ExecutePanel` 根据 `phase` 控制现有 Radix Dialog，并在同一内容区域切换执行中、完成和错误状态。页面不增加新状态层、任务协议、轮询或依赖。

**Tech Stack:** React、TypeScript、Radix Dialog、Tailwind CSS、Lucide React、Vitest、Testing Library、Playwright。

## Global Constraints

- 不改变 Job payload、SDK 或后端协议。
- 关闭弹框不取消远程任务。
- 不伪造实时输出；仅展示 Server 返回的最终结果。
- 使用现有 UI 组件和 Lucide，不增加依赖。
- 遵循测试先行，并执行构建、LSP、pi-lens 和 Playwright 验证。

---

### Task 1: 执行进度与结果弹框

**Files:**

- Modify: `packages/frontend/src/pages/execute-panel.tsx`
- Test: `packages/frontend/src/pages/execute-panel.test.tsx`

**Interfaces:**

- Consumes: `useJobAction(): { phase, job, error, run, reset }`
- Produces: `ExecutePanel({ clientId }: { clientId: string })`，提交后立即渲染名为“执行任务”的 Dialog。

- [ ] **Step 1: 写失败测试**

在测试中使用未完成 Promise 模拟 `jobs.wait()`，断言提交后立即出现 `role="dialog"`、`role="status"` 和“正在等待机器返回结果”；断言页面不存在“提交后将在此显示 Job 状态摘要”。解析 Promise 后，断言同一弹框显示退出码和耗时。保留脚本 payload 与错误状态断言。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/pages/execute-panel.test.tsx`

Expected: FAIL，因为当前结果仍渲染在右侧 Card，且没有 Dialog 或执行动画状态。

- [ ] **Step 3: 最小实现**

在 `ExecutePanel` 中：

- 增加 `dialogOpen` 本地状态。
- `submit()` 调用 `action.run()` 前执行 `setDialogOpen(true)`。
- 删除双栏 Grid 和右侧 `ResultSummary` Card。
- 执行按钮在 busy 时显示 Lucide `LoaderCircle` 的 `animate-spin` 和“执行中…”。
- 用现有 `Dialog`、`DialogContent`、`DialogTitle`、`DialogDescription` 渲染 `ExecutionDialogContent`。
- `creating`/`waiting` 渲染 `role="status"`；`complete` 渲染最终 Job 字段；`error` 渲染 `role="alert"`。
- Dialog 的 `onOpenChange` 只控制可见性，不调用 `action.reset()` 或取消接口。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/pages/execute-panel.test.tsx`

Expected: 所有测试 PASS。

- [ ] **Step 5: 回归与静态验证**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/execute-panel.test.tsx src/pages/machine-workspace.test.tsx
pnpm --filter @vcpdeck/frontend build
```

Expected: 测试零失败，TypeScript 与 Vite 构建退出码为 0。

- [ ] **Step 6: 浏览器验证**

通过 Playwright 打开 `/machines/:clientId/execute`，验证：

- 页面只有完整宽度执行卡片，无右侧结果卡。
- 提交后立即出现执行动画弹框。
- 完成后同一弹框显示结果。
- 关闭后 URL 不变，页面仍可再次提交。

- [ ] **Step 7: 变更检查**

运行 LSP、`lens_diagnostics(mode="all")` 和 `gitnexus_detect_changes(scope="unstaged")`；如需提交，提交信息使用：

```bash
git commit -m "优化远程执行反馈交互"
```
