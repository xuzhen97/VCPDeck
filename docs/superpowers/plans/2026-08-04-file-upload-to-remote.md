# 文件上传到远程机器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持浏览器选择单个文件，经 Storage 直传后由现有 `file.import` Job 写入当前远程目录，并提供实时进度、覆盖确认和可保留的 File/Storage 记录。

**Architecture:** 复用现有 `File`、Storage 签名 PUT、`waiting_input` Job 状态和 `file.import` Client 处理器。Server 先创建未派发的上传会话，浏览器直传 Storage，上传完成后 Server 补全导入 payload 并交给现有 Scheduler；Client 下载到临时文件、校验 SHA-256 后按 `overwrite` 写入目标。API 端点放入现有 `EventsController`，避免为一次性编排新增模块循环。

**Tech Stack:** NestJS、Prisma/libSQL、TypeScript/ESM、Socket.IO、React/Vite、Vitest、浏览器原生 `XMLHttpRequest`。

## Global Constraints

- 业务文档、设计文档和代码注释使用简体中文；代码标识符、协议字段、数据库字段和枚举值使用英文。
- TypeScript 使用 strict、ESM，NodeNext 相对导入保留 `.js` 后缀。
- 不新增依赖；浏览器上传进度使用原生 `XMLHttpRequest`。
- 首版只支持单文件，不新增 `file.upload` Job 类型，不新增 Storage 自动清理任务，不新增前端文件大小限制。
- 上传成功、远程写入成功、失败和取消均保留 File 记录与 Storage 对象；导出下载继续遵循相同保留策略。
- 每次修改既有函数、类或方法前，先对目标符号运行 GitNexus upstream impact；HIGH/CRITICAL 风险必须先向用户报告。
- 每个任务提交前运行与任务相关的测试；最终提交前运行 `gitnexus_detect_changes({ scope: "unstaged" })`。
- 保留当前工作区已有未提交改动：`README.md`、`packages/frontend/src/pages/files-panel.tsx`、`packages/frontend/src/pages/files-panel.test.tsx`；编辑前先查看 diff，不得回退或覆盖无关改动。
- 提交信息使用简体中文。

---

## 文件结构与职责

本次实现按职责使用现有文件，新增文件只保留一个前端原生上传 helper：

- Modify `packages/shared/src/index.ts`：补充上传会话输入/响应类型、`FileImportPayload.overwrite`，更新 Job 进度注释。
- Modify `packages/server/src/job/job.service.ts`：创建/完成上传会话、校验 Client 能力、维护 `waiting_input → pending` 激活流程。
- Modify `packages/server/src/events/events.controller.ts`：暴露 `/api/files/upload-sessions` 两个 REST 端点，并发送激活后的 dispatch。
- Modify `packages/server/src/storage/storage.service.ts`：接收浏览器流时统计实际大小、SHA-256 和 Job 进度，持久化 File 完成元数据。
- Modify `packages/server/src/storage/storage.service.test.ts`：覆盖流式元数据和进度持久化。
- Modify `packages/server/src/job/job.service.test.ts`：覆盖上传会话、未派发和幂等激活。
- Create `packages/server/src/events/events.controller.test.ts`：覆盖端点向 JobService 编排并转发 dispatch 的行为。
- Modify `packages/sdk/src/files.ts`：增加创建/完成上传会话 API，并为 `file.import` 增加 `overwrite`。
- Modify `packages/sdk/src/jobs.ts`：给 `wait` 增加可选 `onUpdate` 回调，以便文件页显示远程写入阶段进度。
- Modify `packages/sdk/src/jobs.test.ts`：覆盖新 SDK 请求体和 `onUpdate`。
- Modify `packages/client/src/transfer-handler.ts`：为 `file.import` 增加目标覆盖语义、真实大小和下载进度。
- Modify `packages/client/src/transfer-handler.test.ts`：覆盖冲突、覆盖、摘要失败不破坏原文件和进度。
- Create `packages/frontend/src/api/upload-file.ts`：封装可取消的原生 XHR PUT 及上传进度。
- Create `packages/frontend/src/api/upload-file.test.ts`：覆盖成功、progress、HTTP 错误和 AbortSignal。
- Modify `packages/frontend/src/pages/files-panel.tsx`：增加单文件入口、同名确认、两阶段状态、上传/远程进度、冲突重试和列表刷新。
- Modify `packages/frontend/src/pages/files-panel.test.tsx`：覆盖无冲突上传、确认覆盖、XHR/Job 阶段和失败提示。
- Modify `packages/frontend/src/components/notification-bell.tsx`：把 `waiting_input` 纳入活动任务并区分上传/导入/导出文案。
- Modify `packages/frontend/src/components/notification-bell.test.tsx`：覆盖上传会话通知和 `file.import` 运行进度。

---

### Task 1: 扩展共享协议和 API 类型

**Files:**

- Modify: `packages/shared/src/index.ts:203-242, 278-289`

**Interfaces:**

- Produces `FileUploadSessionCreate`，供 Server controller 和 SDK 复用。
- Produces `FileUploadSession`，包含 `jobId`、`fileId`、`status` 和签名上传 URL。
- Produces `FileImportPayload.overwrite?: boolean`，供 Server dispatch、SDK 和 Client 使用。

- [ ] **Step 1: 对共享类型目标运行 impact 并查看调用方**

Run GitNexus upstream impact for `FileImportPayload` and `FileRef`; record direct callers before editing. If risk is HIGH/CRITICAL, stop and report it before proceeding.

- [ ] **Step 2: 写入类型**

在 `JobProgress`/`FileRef` 附近加入：

```ts
export interface FileUploadSessionCreate {
  clientId: string;
  rootDir: string;
  targetPath: string;
  filename: string;
  size: number;
  mimeType?: string;
  overwrite?: boolean;
}

export interface FileUploadSession {
  jobId: string;
  fileId: string;
  status: JobStatus;
  upload: Pick<FileRef, "url" | "expiresAt">;
}
```

在 `FileImportPayload` 末尾加入 `overwrite?: boolean`；把 `JobInfo.progress` 的注释从仅说明 `file.export` 改成涵盖 Storage 上传和 Client 导入两段。注释保持简体中文。

- [ ] **Step 3: 运行共享包类型检查**

Run: `pnpm --filter @vcpdeck/shared build`
Expected: PASS，且不修改 `packages/shared/dist` 以外的业务文件。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "补充文件上传会话协议"
```

---

### Task 2: Server 上传会话编排与 REST 端点

**Files:**

- Modify: `packages/server/src/job/job.service.ts:67-170`
- Modify: `packages/server/src/events/events.controller.ts:81-137`
- Modify: `packages/server/src/job/job.service.test.ts`
- Create: `packages/server/src/events/events.controller.test.ts`

**Interfaces:**

- Consumes: `FileService.createPending(jobId, clientId, meta)`、`FileService.findById(fileId)`、`FileService.createDownloadToken(fileId)`、`JobScheduler.tryDispatch(clientId)`。
- Produces `JobService.createUploadSession(input, actor): Promise<FileUploadSession>`。
- Produces `JobService.completeUploadSession(jobId): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }>`。
- REST `POST /api/files/upload-sessions` 返回 `FileUploadSession`。
- REST `POST /api/files/upload-sessions/:jobId/complete` 返回 `JobCreateResult`。

- [ ] **Step 1: 对将修改的 Server 符号运行 impact**

Run upstream impact for `JobService.create`, `JobService.cancel`, `EventsController.createJob`, and `FileService.createPending`. Verify the existing `file.export` and `file.import` flows in the blast radius; report HIGH/CRITICAL before editing.

- [ ] **Step 2: 写失败测试：创建会话固定为 waiting_input 且不派发**

在 `job.service.test.ts` 增强 Prisma mock：加入 `file.create`/`file.findUnique`、`client.findUnique` 的可控返回，scheduler mock 加入 `tryDispatch`。测试调用：

```ts
const result = await service.createUploadSession(
  {
    clientId: "c1",
    rootDir: "D:\\",
    targetPath: "uploads/a.txt",
    filename: "a.txt",
    size: 5,
    mimeType: "text/plain",
    overwrite: false,
  },
  actor,
);
expect(prisma.job.create).toHaveBeenCalledWith({
  data: expect.objectContaining({
    type: "file.import",
    status: "waiting_input",
    payload: JSON.stringify({
      rootDir: "D:\\",
      targetPath: "uploads/a.txt",
      fileId: "file-1",
      overwrite: false,
    }),
  }),
});
expect(scheduler.tryDispatch).not.toHaveBeenCalled();
expect(result).toMatchObject({ jobId: "job-1", fileId: "file-1", status: "waiting_input" });
```

- [ ] **Step 3: 运行失败测试**

Run: `pnpm --filter @vcpdeck/server exec vitest run src/job/job.service.test.ts -t "waiting_input"`
Expected: FAIL because `createUploadSession` is not implemented.

- [ ] **Step 4: 实现 `JobService.createUploadSession`**

实现以下顺序：

1. 校验 `clientId` 对应 Client 存在且 online；
2. 校验 `file.write` capability；复用 `parseCapabilities`；
3. 校验 `rootDir`、`targetPath`、`filename` 为非空字符串，`size` 为有限非负整数，`mimeType` 若存在必须为字符串；不增加大小上限；
4. 生成 `jobId = randomUUID()`；
5. 调用 `fileService.createPending(jobId, clientId, { jobId, clientId, filename, size, mimeType })`；
6. 创建 Job，`type: "file.import"`、`status: "waiting_input"`、payload 只保存 `{ rootDir, targetPath, fileId, overwrite: input.overwrite === true }`，并保存 actor 审计字段；
7. 返回 `{ jobId, fileId, status: JobStatus.WAITING_INPUT, upload: { url: uploadUrl, expiresAt } }`；
8. 不调用 scheduler。

如果步骤 6 失败，保留已创建 File/Storage 记录，不引入回滚抽象；后续清理任务会按关联字段处理孤儿记录。

- [ ] **Step 5: 写失败测试：完成接口拒绝未上传并激活已上传 Job**

加入两组测试：

```ts
it("未完成 File 时不激活 waiting_input Job", async () => {
  prisma.job.findUnique.mockResolvedValue({
    id: "job-1", clientId: "c1", type: "file.import", status: "waiting_input",
    payload: JSON.stringify({ rootDir: "D:\\", targetPath: "a.txt", fileId: "file-1" }),
  });
  fileService.findById.mockResolvedValue({ id: "file-1", status: "pending" });
  await expect(service.completeUploadSession("job-1")).rejects.toMatchObject({ code: "FILE_NOT_READY" });
  expect(prisma.job.update).not.toHaveBeenCalled();
});

it("完成上传后补全 downloadRef、转 pending 并返回 dispatch", async () => {
  prisma.job.findUnique.mockResolvedValue({
    id: "job-1", clientId: "c1", type: "file.import", status: "waiting_input",
    payload: JSON.stringify({ rootDir: "D:\\", targetPath: "a.txt", fileId: "file-1", overwrite: true }),
  });
  fileService.findById.mockResolvedValue({
    id: "file-1", status: "completed", key: "storage-key", size: 5, sha256: "sha",
  });
  fileService.createDownloadToken.mockResolvedValue({
    downloadUrl: "/api/storage/download/storage-key?expires=...&sig=x", size: 5, sha256: "sha",
  });
  scheduler.tryDispatch.mockResolvedValue({
    jobId: "job-1", clientId: "c1", type: "file.import", payload: expect.any(Object),
  });
  const result = await service.completeUploadSession("job-1");
  expect(prisma.job.update).toHaveBeenCalledWith({
    where: { id: "job-1" },
    data: expect.objectContaining({ status: "pending", payload: expect.stringContaining("downloadRef") }),
  });
  expect(result.dispatch).toMatchObject({ jobId: "job-1", type: "file.import" });
});
```

重复调用规则测试为：`pending`、`running`、`done`、`error`、`disconnected` 返回当前 Job/不重复派发；`cancelled` 抛出 `UPLOAD_SESSION_CANCELLED`；仍为 `waiting_input` 且 File 未 completed 抛出 `FILE_NOT_READY`。`waiting_input` 且 File completed 才执行激活。

- [ ] **Step 6: 实现 `JobService.completeUploadSession`**

实现：

1. 查询 Job；不存在抛出带 `code: "UPLOAD_SESSION_NOT_FOUND"` 的错误；
2. 校验 `type === "file.import"`；
3. 对已激活状态（`pending`、`running`、`done`、`error`、`disconnected`）返回当前状态，不调用 scheduler；
4. `cancelled` 抛出 `UPLOAD_SESSION_CANCELLED`；
5. `waiting_input` 时解析 payload，读取 `fileId`，查询 File；File 不存在或 `status !== "completed"` 抛出 `FILE_NOT_READY`；
6. 调用 `fileService.createDownloadToken(fileId)`；
7. 合并原 payload 与 `{ downloadRef: { id: fileId, key: file.key, url: downloadUrl, method: "GET", expiresAt: 0 }, size, sha256 }`，更新 Job 为 `pending`；
8. 调用 `scheduler.tryDispatch(clientId)`；
9. 如果 dispatch 的 jobId 是当前 Job，返回 `running`，否则返回 `pending`；返回 dispatch 供 Controller 转发。

使用现有 `safeJsonParse`，不要新增 payload 工厂或配置层。

- [ ] **Step 7: 添加 REST 端点测试**

`events.controller.test.ts` 直接实例化 Controller，mock `JobService`、`ClientService`、`ClientGateway`，断言：

- `createUploadSession` 把 Body 和 Actor 原样传给 `jobService.createUploadSession`；
- `completeUploadSession` 收到 dispatch 时调用 `gateway.sendDispatch(dispatch)`；
- 未收到 dispatch 时不调用 `sendDispatch`；
- 返回值只返回 service 的 `result`，不把内部 dispatch 暴露给客户端。

- [ ] **Step 8: 实现 Controller 端点**

在 `@Controller("api")` 的 `EventsController` 中加入：

```ts
@Post("files/upload-sessions")
async createUploadSession(
  @Body() body: FileUploadSessionCreate,
  @Actor() actor: ActorContext,
) {
  try {
    return await this.jobService.createUploadSession(body, actor);
  } catch (e: any) {
    throw new BadRequestException({ code: e.code ?? "INVALID_UPLOAD_SESSION", message: e.message ?? String(e) });
  }
}

@Post("files/upload-sessions/:jobId/complete")
async completeUploadSession(@Param("jobId") jobId: string) {
  try {
    const { result, dispatch } = await this.jobService.completeUploadSession(jobId);
    if (dispatch) this.gateway.sendDispatch(dispatch);
    return result;
  } catch (e: any) {
    throw new BadRequestException({ code: e.code ?? "UPLOAD_SESSION_INVALID", message: e.message ?? String(e) });
  }
}
```

为方法补充简体中文 JSDoc；保留现有 `/api/jobs` 行为不变。

- [ ] **Step 9: 运行 Server 单元测试和构建**

Run: `pnpm --filter @vcpdeck/server exec vitest run src/job/job.service.test.ts src/events/events.controller.test.ts`
Expected: PASS。

Run: `pnpm --filter @vcpdeck/server build`
Expected: PASS。

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/job/job.service.ts packages/server/src/job/job.service.test.ts packages/server/src/events/events.controller.ts packages/server/src/events/events.controller.test.ts
git commit -m "增加文件上传会话编排"
```

---

### Task 3: Storage 流式元数据、进度与 File 持久化

**Files:**

- Modify: `packages/server/src/storage/storage.service.ts:1-160`
- Modify: `packages/server/src/storage/storage.service.test.ts`

**Interfaces:**

- Consumes: `PendingUpload.meta.jobId`、`StorageProvider.uploadToKey`、`PrismaService.job.update`。
- Produces: `receiveUpload` 在 provider 完成后把 File 的 `key`、`status`、实际 `size`、`sha256` 写入数据库，并按节流更新 Job `progress`。

- [ ] **Step 1: 对 `StorageService.receiveUpload` 运行 upstream impact**

检查 Storage Controller、FileService、Client export、下载和现有测试调用方。HIGH/CRITICAL 风险先报告。

- [ ] **Step 2: 写失败测试：消费真实流并持久化实际元数据**

更新 `storage.service.test.ts` 的 provider mock，使 `uploadToKey` 消费传入 Readable 并返回真实 key。测试使用：

```ts
const stream = Readable.from([Buffer.from("hello")]);
await service.receiveUpload("temporary-key/a.txt", stream, 0, "sig");
expect(prisma.file.updateMany).toHaveBeenCalledWith({
  where: { key: "temporary-key/a.txt" },
  data: {
    key: "aliyun-file-id",
    status: "completed",
    size: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  },
});
```

再增加带 `jobId: "job-1"` 的 pending 元数据测试，断言 `prisma.job.update` 至少收到 `{ progress: JSON.stringify({ loaded: 5, total: 5 }) }`。

- [ ] **Step 3: 运行失败测试**

Run: `pnpm --filter @vcpdeck/server exec vitest run src/storage/storage.service.test.ts -t "实际元数据"`
Expected: FAIL，因为当前实现只更新 key/status 且不消费/计算输入流。

- [ ] **Step 4: 实现流式 tracker**

在 `storage.service.ts` 使用 Node 标准库 `createHash`、`Transform`：

```ts
function trackUpload(
  source: Readable,
  jobId: string,
  total: number,
  onProgress: (loaded: number, total: number) => Promise<void>,
) {
  const hash = createHash("sha256");
  let loaded = 0;
  let lastEmitAt = 0;
  let lastEmitBytes = 0;
  let progressWrite = Promise.resolve();
  const tracker = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      loaded += buffer.length;
      const now = Date.now();
      if (now - lastEmitAt >= 500 || loaded - lastEmitBytes >= 1024 * 1024) {
        lastEmitAt = now;
        lastEmitBytes = loaded;
        progressWrite = progressWrite.then(() => onProgress(loaded, total)).catch(() => {});
      }
      callback(null, buffer);
    },
    flush(callback) {
      if (loaded !== lastEmitBytes && jobId) {
        progressWrite = progressWrite.then(() => onProgress(loaded, total)).catch(() => {});
      }
      callback();
    },
  });
  return { stream: source.pipe(tracker), hash, getLoaded: () => loaded, waitProgress: () => progressWrite };
}
```

`receiveUpload` 先按 `meta.jobId` 查询 Job 类型；只有关联 Job 的类型为 `file.import` 时才建立浏览器上传进度 tracker。这样不会用 Storage 接收阶段的 `total: 0` 覆盖现有 `file.export` 的 Client 上传进度；无 Job 或 `file.export` 直接复用原始 stream。对 `file.import` 调用 `prisma.job.update({ where: { id: jobId }, data: { progress: ... } })`；进度写入失败只记录/吞掉，不阻断 Storage 上传。上传完成后等待 tracker 的 progress chain，再调用 `file.updateMany`，数据为 `{ key: entry.key, status: "completed", size: loaded, sha256: hash.digest("hex") }`。保留 pending 缓存丢失时从 File 表恢复 metadata 和最终 fallback。

当 `file.import` provider 上传失败或流异常时，在 `receiveUpload` 的 catch 中把 Job 更新为 `status: "error"`、`errorCode: "IO_ERROR"`、`errorMessage: "Storage upload failed"`，再重新抛出让 HTTP 请求失败；不把原始异常、路径或文件内容写入 Job。导出 Job 继续由 Client 的上传失败回调负责终态。

不要把 `StorageService` 依赖到 `JobService`，避免 StorageModule/FileModule/JobModule 循环；直接更新已有 Prisma Job 表。

- [ ] **Step 5: 补充失败路径测试并修正现有 stream 类型**

加入 provider 抛错测试：`file.import` Job 被更新为 `{ status: "error", errorCode: "IO_ERROR", errorMessage: "Storage upload failed" }`，同时 `file.updateMany` 不被调用。断言 `file.export` 的 Storage 接收不会写入 `total: 0` 的 Job 进度。

把传入 `receiveUpload` 的 `{}` 替换为 `Readable.from([])` 或实际 Buffer，更新既有 `updateMany` 断言以包含 size/sha256。运行：

```bash
pnpm --filter @vcpdeck/server exec vitest run src/storage/storage.service.test.ts
```

Expected: PASS。

- [ ] **Step 6: 回归 Server 构建**

Run: `pnpm --filter @vcpdeck/server build`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/storage/storage.service.ts packages/server/src/storage/storage.service.test.ts
git commit -m "持久化文件上传元数据和进度"
```

---

### Task 4: Client 导入覆盖、真实大小和进度

**Files:**

- Modify: `packages/client/src/transfer-handler.ts:60-230`
- Modify: `packages/client/src/transfer-handler.test.ts`

**Interfaces:**

- Consumes `payload.size?: number` and `payload.overwrite?: boolean` from `file.import` dispatch.
- Produces `PATH_CONFLICT` without modifying an existing target when overwrite is false; produces result `{ path, size, sha256 }`; emits `JOB_PROGRESS` for Storage → Client bytes.

- [ ] **Step 1: 对 `handleTransfer`、`handleImport` 运行 upstream impact**

检查 Dispatcher、Client transfer tests 和 shared dispatch 类型。HIGH/CRITICAL 风险先报告。

- [ ] **Step 2: 写失败测试：默认冲突、允许覆盖、摘要失败保留原文件**

扩展 `node:fs/promises` mock 的 `stat`/`unlink`/`rename`，让 `createWriteStream` 返回可消费的 Writable 或保留现有测试 helper。增加 payload builder：

```ts
function importJob(overwrite = false) {
  return {
    jobId: "job-1",
    type: "file.import",
    payload: {
      rootDir: "C:\\root",
      targetPath: "a.txt",
      downloadRef: { id: "f1", key: "k", url: "/download", method: "GET", expiresAt: 0 },
      size: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      overwrite,
    },
  };
}
```

覆盖：

- 目标已有普通文件、`overwrite: false`：没有 `rename`，收到 `JOB_DONE` error `PATH_CONFLICT`；
- 目标已有普通文件、`overwrite: true`：调用 `unlink` 后 `rename`，收到 done，size 为 5；
- 下载内容摘要错误：没有删除/替换目标文件，临时文件被 unlink，收到 `SHA256_MISMATCH`；
- 分块下载至少发出最终 `{ loaded: 5, total: 5 }` 进度。

- [ ] **Step 3: 运行失败测试**

Run: `pnpm --filter @vcpdeck/client exec vitest run src/transfer-handler.test.ts -t "PATH_CONFLICT|overwrite|SHA256_MISMATCH"`
Expected: FAIL，因为当前 `file.import` 不读取 overwrite、不会检查目标、结果 size 使用 `downloadRef.expiresAt`。

- [ ] **Step 4: 实现 `handleTransfer` 参数解析**

将现有调用改为：

```ts
const expectedSize = Number(payload.size ?? 0);
const overwrite = payload.overwrite === true;
await handleImport(
  jobId,
  targetPath,
  rootDir,
  downloadRef,
  expectedSha256,
  expectedSize,
  overwrite,
  socket,
);
```

- [ ] **Step 5: 实现 `handleImport` 下载进度和最终写入**

使用 `Transform` 代替当前只监听 `PassThrough` 的方式：每个 chunk 更新 hash/loaded，并按 500ms 或 1MiB 节流发送 `Events.JOB_PROGRESS`；flush 时补发精确总量。使用 `pipeline(nodeBody, tracker, createWriteStream(tmpPath))`，完成后比较摘要。

摘要成功后：

1. `stat(safe).catch(() => null)`；
2. 已存在目录始终返回 `PATH_CONFLICT`；
3. 已存在文件且 `overwrite !== true` 返回 `PATH_CONFLICT`；
4. overwrite 为 true 时 `unlink(safe)` 后 `rename(tmpPath, safe)`；没有目标时直接 rename；
5. done 结果使用 `{ path: safe, size: loaded, sha256 }`；
6. catch 中继续 unlink 临时文件，避免覆盖已有文件。

导入计数 total 使用 payload 的 `size`；若为 0，进度仍发送 `loaded`/`total: 0`，不会伪造大小。

- [ ] **Step 6: 运行 Client 测试和构建**

Run: `pnpm --filter @vcpdeck/client exec vitest run src/transfer-handler.test.ts`
Expected: PASS。

Run: `pnpm --filter @vcpdeck/client build`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/transfer-handler.ts packages/client/src/transfer-handler.test.ts
git commit -m "支持导入文件覆盖和传输进度"
```

---

### Task 5: SDK 上传会话、可观察等待和导入参数

**Files:**

- Modify: `packages/sdk/src/files.ts:1-118`
- Modify: `packages/sdk/src/jobs.ts:12-82`
- Modify: `packages/sdk/src/jobs.test.ts`

**Interfaces:**

- Produces `files.createUploadSession(input, signal?)` → `FileUploadSession`。
- Produces `files.completeUpload(jobId, signal?)` → `JobCreateResult`。
- Extends `files.import` payload with `overwrite?: boolean`。
- Extends `WaitJobOptions` with `onUpdate?: (job: JobInfo) => void`，在每次 REST 查询后调用。

- [ ] **Step 1: 对 SDK `createFilesApi` 和 `createJobsApi.wait` 运行 impact**

检查 `VcpDeckClient` 构造、文件 API tests、通知组件和所有 `jobs.wait` 调用方。HIGH/CRITICAL 风险先报告。

- [ ] **Step 2: 写失败测试**

在 `jobs.test.ts` 增加：

```ts
it("creates and completes an upload session", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ jobId: "j1", fileId: "f1", status: JobStatus.WAITING_INPUT,
      upload: { url: "/api/storage/upload/k", expiresAt: 123 } })
    .mockResolvedValueOnce({ jobId: "j1", status: JobStatus.PENDING, type: "file.import" });
  const files = createFilesApi({ request } as never);
  await expect(files.createUploadSession({
    clientId: "c1", rootDir: "D:\\", targetPath: "a.txt", filename: "a.txt", size: 5,
  })).resolves.toMatchObject({ fileId: "f1" });
  await files.completeUpload("j1");
  expect(request).toHaveBeenNthCalledWith(1, "POST", "/api/files/upload-sessions", expect.any(Object), undefined);
  expect(request).toHaveBeenNthCalledWith(2, "POST", "/api/files/upload-sessions/j1/complete", undefined, undefined);
});

it("wait invokes onUpdate for intermediate job states", async () => {
  vi.useFakeTimers();
  const request = vi.fn()
    .mockResolvedValueOnce({ jobId: "j1", status: JobStatus.RUNNING, progress: { loaded: 2, total: 5 } })
    .mockResolvedValueOnce({ jobId: "j1", status: JobStatus.DONE });
  const onUpdate = vi.fn();
  const promise = createJobsApi({ request } as never).wait("j1", { onUpdate });
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(2000);
  await expect(promise).resolves.toMatchObject({ status: JobStatus.DONE });
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ progress: { loaded: 2, total: 5 } }));
  vi.useRealTimers();
});
```

也断言 `files.import(..., overwrite: true)` 的 POST body 保留该字段。

- [ ] **Step 3: 运行失败测试**

Run: `pnpm --filter @vcpdeck/sdk exec vitest run src/jobs.test.ts -t "upload session|onUpdate|overwrite"`
Expected: FAIL，因为新方法和回调尚未存在。

- [ ] **Step 4: 实现 SDK 方法**

在 `files.ts` 导入共享类型，加入：

```ts
createUploadSession: (input: FileUploadSessionCreate, signal?: AbortSignal) =>
  client.request<FileUploadSession>("POST", "/api/files/upload-sessions", input, signal),
completeUpload: (jobId: string, signal?: AbortSignal) =>
  client.request<JobCreateResult>(
    "POST",
    `/api/files/upload-sessions/${encodeURIComponent(jobId)}/complete`,
    undefined,
    signal,
  ),
```

`import` 的 payload 类型改为 `{ rootDir; targetPath; fileId; overwrite?: boolean }` 并继续通过现有 `run` 创建/等待 Job。

在 `jobs.ts` 中把 `WaitJobOptions` 扩展为：

```ts
export interface WaitJobOptions {
  signal?: AbortSignal;
  delays?: readonly number[];
  onUpdate?: (job: JobInfo) => void;
}
```

每次 `client.request<JobInfo>` 返回后先调用 `options.onUpdate?.(job)`，再判断终态；不改变默认轮询延迟和 Abort 行为。

- [ ] **Step 5: 运行 SDK 测试和构建**

Run: `pnpm --filter @vcpdeck/sdk test`
Expected: PASS。

Run: `pnpm --filter @vcpdeck/sdk build`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/files.ts packages/sdk/src/jobs.ts packages/sdk/src/jobs.test.ts
git commit -m "增加文件上传会话 SDK"
```

---

### Task 6: 浏览器原生上传 helper

**Files:**

- Create: `packages/frontend/src/api/upload-file.ts`
- Create: `packages/frontend/src/api/upload-file.test.ts`

**Interfaces:**

- Produces `uploadFile(url: string, file: File, options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void }): Promise<void>`。
- Rejects non-2xx HTTP status with `Error("上传失败：HTTP <status>")`。
- Rejects network/XHR failure with `Error("上传失败")`。
- Rejects abort with DOMException `AbortError` and calls `xhr.abort()` when signal aborts。

- [ ] **Step 1: 写失败测试**

用可控的 fake `XMLHttpRequest` 覆盖：

- `open("PUT", url)`、`send(file)` 被调用；
- `upload.onprogress` 触发后回调收到 loaded/total；
- status 200 resolve；
- status 500 reject；
- signal.abort 调用 `abort` 并 reject AbortError。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/api/upload-file.test.ts`
Expected: FAIL，因为 helper 文件不存在。

- [ ] **Step 3: 实现最小 XHR helper**

实现时：

1. `new XMLHttpRequest()`；
2. `open("PUT", url)`；
3. `upload.onprogress` 只在 `lengthComputable` 时回调，否则回调传 `loaded` 和 `file.size`；
4. `onload` 以 `status >= 200 && status < 300` 判定成功；
5. `onerror`/`ontimeout` 使用稳定中文错误；
6. 绑定 AbortSignal，并在 settle 后移除 listener；
7. 不设置额外认证头，签名 URL 自身为公开临时授权。

- [ ] **Step 4: 运行 helper 测试**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/api/upload-file.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/api/upload-file.ts packages/frontend/src/api/upload-file.test.ts
git commit -m "增加浏览器文件上传进度封装"
```

---

### Task 7: 文件页上传交互与冲突重试

**Files:**

- Modify: `packages/frontend/src/pages/files-panel.tsx`
- Modify: `packages/frontend/src/pages/files-panel.test.tsx`

**Interfaces:**

- Consumes `sdk.files.createUploadSession`、`uploadFile`、`sdk.files.completeUpload`、`sdk.jobs.wait`、`sdk.files.import`。
- Produces a single-file toolbar upload entry using current `browser.selectedRoot` and `browser.path`; after done calls `browser.refresh()`.

- [ ] **Step 1: 对 `FilesPanel` 运行 upstream impact 并读取当前未提交 diff**

Run impact for `FilesPanel`, then inspect `git diff -- packages/frontend/src/pages/files-panel.tsx packages/frontend/src/pages/files-panel.test.tsx`. Preserve the existing bottom context-menu fix and all unrelated local changes.

- [ ] **Step 2: 写失败测试：无冲突上传**

在现有 `renderFiles` mock 中，把 `createUploadSession`、`completeUpload`、`import` 放入 `files`，把 `wait` 放入 SDK client 顶层 `jobs`：

```ts
const files = {
  // 现有 files mock 保留
  createUploadSession: vi.fn().mockResolvedValue({
    jobId: "upload-job",
    fileId: "file-1",
    status: "waiting_input",
    upload: { url: "/api/storage/upload/k", expiresAt: 123 },
  }),
  completeUpload: vi.fn().mockResolvedValue({ jobId: "upload-job", status: "running", type: "file.import" }),
  import: vi.fn(),
};
const client = {
  files,
  jobs: { wait: vi.fn().mockResolvedValue({ status: "done", progress: { loaded: 5, total: 5 } }) },
  // 现有 storage mock 保留
};
```

在测试文件顶部 `vi.mock("@/api/upload-file", () => ({ uploadFile: vi.fn().mockResolvedValue(undefined) }))`，选择 `report.txt` 后断言：

```ts
expect(files.createUploadSession).toHaveBeenCalledWith({
  clientId: "client-1",
  rootDir: "D:\\",
  targetPath: "report.txt",
  filename: "report.txt",
  size: 5,
  mimeType: "text/plain",
  overwrite: false,
}, expect.any(AbortSignal));
expect(files.completeUpload).toHaveBeenCalledWith("upload-job", expect.any(AbortSignal));
expect(client.jobs.wait).toHaveBeenCalledWith("upload-job", expect.objectContaining({ onUpdate: expect.any(Function) }));
```

- [ ] **Step 3: 写失败测试：同名确认和冲突后复用 File**

用现有 `README.md` 条目作为同名文件，选择同名 File 后断言初始创建会话不立即发生；点击上传确认按钮后断言 `overwrite: true`。再让 wait 返回 `{ status: "error", errorCode: "PATH_CONFLICT" }`，断言出现“覆盖”确认；确认后断言调用：

```ts
files.import("client-1", {
  rootDir: "D:\\",
  targetPath: "README.md",
  fileId: "file-1",
  overwrite: true,
}, expect.any(AbortSignal));
```

- [ ] **Step 4: 运行失败测试**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/pages/files-panel.test.tsx -t "上传|覆盖"`
Expected: FAIL，因为文件页没有上传入口和状态。

- [ ] **Step 5: 实现文件页上传状态和入口**

在当前目录工具栏增加隐藏单文件 input 与“上传文件”按钮。XHR 使用 `${window.location.origin}${session.upload.url}` 作为 URL。新增最小状态：

```ts
type UploadState =
  | { phase: "uploading"; filename: string; loaded: number; total: number }
  | { phase: "importing"; filename: string; loaded: number; total: number }
  | { phase: "done"; filename: string }
  | { phase: "error"; filename: string; message: string };
```

实现 `targetPath = browser.path === "." ? file.name :`${browser.path}/${file.name}``。选择文件后：

- 同名 `File` 或 `dir`：保存待确认文件并打开自有 Dialog；
- 无冲突：调用 `startUpload(file, false)`；
- Dialog 确认：调用 `startUpload(file, true)`；
- 创建会话、`uploadFile`、完成会话、`sdk.jobs.wait` 按顺序执行；`onProgress` 设置 `phase: "uploading"`；`onUpdate` 设置 `phase: "importing"` 和 Job progress；
- `jobs.wait` 返回 done 后设置 done、调用 `browser.refresh()`；error/cancelled 把 errorMessage/errorCode 显示在文件页；
- 全部请求使用当前组件的 `AbortController`，组件卸载时 abort，不能在卸载后 setState。

使用已有 `Dialog`/`Button`/`Input`，不用创建新确认组件；确认文案明确写“覆盖当前目录中的 `<fullTarget>`？”。

- [ ] **Step 6: 实现并发 PATH_CONFLICT 重试**

当初始上传 Job 返回 error 且 `errorCode === "PATH_CONFLICT"` 时保存 `{ fileId, rootDir, targetPath, filename }`，打开覆盖确认 Dialog。确认后直接调用 `sdk.files.import`，不重新调用 `createUploadSession` 和 `uploadFile`；等待新 Job 终态后成功刷新，失败显示错误。

- [ ] **Step 7: 运行文件页测试和构建**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/pages/files-panel.test.tsx`
Expected: PASS，且现有文件浏览、移动、删除、右键菜单测试不回归。

Run: `pnpm --filter @vcpdeck/frontend build`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/pages/files-panel.tsx packages/frontend/src/pages/files-panel.test.tsx
git commit -m "增加文件页上传到远程机器"
```

---

### Task 8: 任务通知的上传/导入阶段展示

**Files:**

- Modify: `packages/frontend/src/components/notification-bell.tsx:7-205, 260-277`
- Modify: `packages/frontend/src/components/notification-bell.test.tsx`

**Interfaces:**

- Consumes `JobInfo.status` values `waiting_input`/`pending`/`running` and payload `targetPath`/`path`。
- Produces distinct notification labels: Storage 上传、等待派发、远程目录写入；只为 `file.export` 显示下载按钮。

- [ ] **Step 1: 对 `NotificationBell` 运行 upstream impact**

检查通知测试、Dashboard/Jobs 页是否复用 `filenameOf` 或状态常量。HIGH/CRITICAL 风险先报告。

- [ ] **Step 2: 写失败测试**

加入两个测试：

1. `waiting_input` 的 `file.import` payload `{ targetPath: "uploads/a.txt" }` 出现在活动区，显示“正在上传到 Storage”，并且通知未显示下载按钮；
2. `running` 的 `file.import` payload `{ targetPath: "uploads/a.txt" }` 带 `{ loaded: 2, total: 5 }`，显示“正在写入远程目录”和 `40%`。

- [ ] **Step 3: 运行失败测试**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/components/notification-bell.test.tsx -t "Storage|远程目录"`
Expected: FAIL，因为 `waiting_input` 当前不在活动集合且 filename 只读取 `payload.path`。

- [ ] **Step 4: 实现通知状态与文案**

- `ACTIVE_STATUSES` 改为包含 `"pending"`、`"running"`、`"waiting_input"`；
- `filenameOf` 优先使用 `payload.path ?? payload.targetPath ?? payload.filename`，取最后路径片段；
- `ProgressBar` 接收 `status` 和 `type`：
  - `waiting_input`：显示“正在上传到 Storage”，使用字节/百分比；
  - `pending`：显示“等待派发”；
  - `running` + `file.import`：显示“正在写入远程目录”，使用字节/百分比；
  - `file.export` 保留既有“上传完成 · 正在保存到云盘…”收尾文案；
- finished 区只在 `item.type === "file.export"` 且有 key 时渲染 `DownloadButton`；
- 更新组件注释，说明活动状态包括上传等待阶段。

- [ ] **Step 5: 运行通知测试和构建**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/components/notification-bell.test.tsx`
Expected: PASS。

Run: `pnpm --filter @vcpdeck/frontend build`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/components/notification-bell.tsx packages/frontend/src/components/notification-bell.test.tsx
git commit -m "展示文件上传和导入任务进度"
```

---

### Task 9: 全量回归、范围检查与人工验证

**Files:**

- No planned production changes.

**Interfaces:**

- Consumes all tasks above and the approved design at `docs/superpowers/specs/2026-08-04-file-upload-to-remote-design.md`.
- Produces verified test/build output and a GitNexus affected-flow report.

- [ ] **Step 1: 运行各包测试**

```bash
pnpm --filter @vcpdeck/shared build
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/frontend test
```

Expected: all commands exit 0。

- [ ] **Step 2: 运行全量构建和 lint**

```bash
pnpm build
pnpm lint
```

Expected: all commands exit 0；若 lint 发现本次新增代码问题，先修复并重新执行，不修改无关文件。

- [ ] **Step 3: 检查诊断**

Run `lsp_diagnostics`/`lens_diagnostics(mode="all")` 对本次编辑文件执行检查。Expected: 没有由本次改动新增的 blocking error。

- [ ] **Step 4: 运行 GitNexus 影响范围检查**

Run:

```json
{
  "repo": "VCPDeck",
  "scope": "unstaged"
}
```

使用 `gitnexus_detect_changes`，确认变更只覆盖：共享 FileImport 协议、上传会话 Job/REST、Storage 接收、Client file.import、SDK 文件 API、文件页上传、通知进度及对应测试。若出现 README 或当前既有文件页无关符号，停止并清理 staging/提交边界，不回退用户原有修改。

- [ ] **Step 5: 人工冒烟验证**

在本地 Server、Client、Frontend 启动后：

1. 打开一个在线 Client 的文件页并进入远程目录；
2. 上传一个小文本文件，确认默认目标为当前目录；
3. 观察文件页上传进度、顶部通知 `waiting_input`/`running` 文案和进度；
4. 上传同名文件，确认未自动覆盖；确认后才允许覆盖；
5. 让一次远程写入产生冲突，确认 Storage/File 保留且可以复用 `fileId` 重试；
6. 验证导出下载仍能生成下载链接，通知仍有下载按钮；
7. 验证失败任务显示稳定错误码/原因。

- [ ] **Step 6: 最终状态检查**

Run:

```bash
git status --short
git diff --check
```

确认没有意外修改或未追踪的临时文件；保留用户在开始任务前已有的三处未提交改动，并在最终报告中单独列出。

- [ ] **Step 7: Final commit**

所有测试、构建和范围检查通过后，按仓库约定使用简体中文提交本次实现剩余文件，例如：

```bash
git add packages/shared/src/index.ts packages/server packages/sdk packages/client packages/frontend/src/api packages/frontend/src/pages/files-panel.tsx packages/frontend/src/pages/files-panel.test.tsx packages/frontend/src/components/notification-bell.tsx packages/frontend/src/components/notification-bell.test.tsx
git commit -m "实现浏览器文件上传到远程机器"
```

提交前不得加入用户原有的 `README.md` 改动；若文件页原有改动与本功能同文件，使用精确 staging 或拆分提交保留其独立边界。
