-- CreateTable: JobLogEvent（Job 诊断事件链，ADR-0054）
-- 只保存生命周期事实（事件名/级别/稳定码/脱敏短文本/白名单 data），
-- 不保存命令、脚本、路径或 stdout/stderr 正文；seq 由自增主键承担。
CREATE TABLE "JobLogEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "code" TEXT,
    "message" TEXT,
    "data" TEXT,
    CONSTRAINT "JobLogEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "JobLogEvent_jobId_id_idx" ON "JobLogEvent" ("jobId", "id");
CREATE INDEX "JobLogEvent_at_idx" ON "JobLogEvent" ("at");
CREATE INDEX "JobLogEvent_level_at_idx" ON "JobLogEvent" ("level", "at");
