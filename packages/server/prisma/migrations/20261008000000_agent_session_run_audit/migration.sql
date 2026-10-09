-- Agent 会话/执行/审计独立实体(ADR-0041)。
-- 由 packages/server/prisma/agent-session-migration.cjs 显式调用,不依赖 db push 生成。
-- 幂等性由调用方以 AgentMigration 版本标记保证;本文件按全新建表编写。
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "ownerIdentityId" TEXT,
    "ownerName" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "lastActivityAt" DATETIME,
    "archivedAt" DATETIME,
    "deletedAt" DATETIME,
    "activeRunId" TEXT,
    "toolExecutionModeOverride" TEXT,
    "executionModeNeedsConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "legacyExecutionModeOverride" TEXT,
    "deleteToken" TEXT,
    "deletePreviousStatus" TEXT,
    "migratedFromJob" BOOLEAN NOT NULL DEFAULT false,
    "legacyJobStatus" TEXT,
    CONSTRAINT "AgentSession_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentSession_activeRunId_key" ON "AgentSession"("activeRunId");
CREATE INDEX "AgentSession_clientId_status_idx" ON "AgentSession"("clientId", "status");

CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "kind" TEXT NOT NULL DEFAULT 'prompt',
    "executionMode" TEXT,
    "createdByIdentityId" TEXT,
    "createdByName" TEXT,
    "createdVia" TEXT,
    "createdAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "errorCode" TEXT,
    CONSTRAINT "AgentRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "AgentRun_sessionId_createdAt_id_idx" ON "AgentRun"("sessionId", "createdAt", "id");
CREATE INDEX "AgentRun_clientId_status_idx" ON "AgentRun"("clientId", "status");

CREATE TABLE "AgentAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'requested',
    "identityId" TEXT,
    "actorName" TEXT,
    "source" TEXT,
    "operationId" TEXT,
    "oldExecutionMode" TEXT,
    "newExecutionMode" TEXT,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "AgentAuditEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentAuditEvent_operationId_event_result_key" ON "AgentAuditEvent"("operationId", "event", "result");
CREATE INDEX "AgentAuditEvent_sessionId_createdAt_id_idx" ON "AgentAuditEvent"("sessionId", "createdAt", "id");
CREATE INDEX "AgentAuditEvent_clientId_createdAt_id_idx" ON "AgentAuditEvent"("clientId", "createdAt", "id");

-- 迁移版本标记(单行)
CREATE TABLE "AgentMigration" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "sqlDigest" TEXT NOT NULL,
    "appliedAt" DATETIME NOT NULL
);
