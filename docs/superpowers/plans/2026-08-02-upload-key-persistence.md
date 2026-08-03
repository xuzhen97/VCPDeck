# 上传真实 Key 持久化修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 上传完成时由 Server 持久化存储后端返回的真实 key，并阻止旧 Client 的临时 key 污染 File 与 Job，使自动下载、任务通知、任务详情使用同一真实 key。

**Architecture:** `StorageService.receiveUpload()` 在 provider 完成上传后按旧上传 key 更新 File 记录；`FileService.confirmUpload()` 只确认摘要和状态，不再接收或写入 Client 回传 key；`ClientGateway.handleJobDone()` 使用确认后的 File key 规范化 Job result，再落库和广播。无新增依赖、无前端下载路径改造。

**Tech Stack:** NestJS、Prisma/libSQL、Vitest、TypeScript。

## Global Constraints

- 业务注释和提交信息使用简体中文。
- 保留现有 File schema 与本地/阿里云盘双后端兼容性。
- 不修改与本问题无关的既有工作区改动。
- 真实下载链接继续使用永久签名语义 `ttlSeconds <= 0`。

---

### Task 1: Server 上传完成时持久化真实 key

**Files:**

- Modify: `packages/server/src/storage/storage.service.ts`
- Test: `packages/server/src/storage/storage.service.test.ts`

- [x] 写测试：模拟 provider 返回真实 key，断言旧 File key 被替换并标记为 completed。
- [x] 运行该测试，确认当前实现失败。
- [x] 在 pending 与 fallback 两条 receiveUpload 路径共用上传完成后的持久化逻辑：`File.updateMany({ where: { key: uploadKey }, data: { key: entry.key, status: "completed" } })`。
- [x] 运行 StorageService 测试。

### Task 2: 完成回调不得覆盖真实 key，并规范化 Job result

**Files:**

- Modify: `packages/server/src/file/file.service.ts`
- Modify: `packages/server/src/events/client.gateway.ts`
- Create: `packages/server/src/file/file.service.test.ts`
- Test: `packages/server/src/events/client.gateway.test.ts`

- [x] 写 FileService 测试：`confirmUpload(fileId, sha256)` 更新摘要和状态，但不写入 Client 临时 key。
- [x] 运行测试确认当前接口/实现不满足目标。
- [x] 将 `confirmUpload` 改为只接收 `fileId`、`sha256`，保留数据库中已持久化的 key。
- [x] 在 `handleJobDone` 中用 `confirmUpload` 返回的 canonical key 覆盖内存中的 Job result，再调用 `markDone` 和广播。
- [x] 写 gateway 回归测试，验证 Client 回传临时 key 时最终 `markDone` 收到真实 key。
- [x] 运行 Server 全部测试和构建。

### Task 3: 真实环境验证与范围检查

**Files:**

- No additional production files.

- [x] 使用 151MB nginx 文件重新导出。
- [x] 验证 File.key、Job.result.key 都是 40 位 fileId。
- [x] 用 Playwright 验证文件面板自动下载、任务通知下载、任务详情下载均成功且文件名为 `nginx-1.18.0.zip`。
- [x] 运行 `pnpm build` 与相关测试。
- [x] 运行 `gitnexus_detect_changes({ scope: "unstaged" })`，确认只影响预期符号和流程。
