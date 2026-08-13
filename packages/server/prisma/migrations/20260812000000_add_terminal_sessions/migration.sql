-- CreateTable: TerminalSession（交互式终端会话元数据；终端正文/快照/token 不入库）
CREATE TABLE "TerminalSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "shellId" TEXT NOT NULL,
    "shellLabel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "cols" INTEGER NOT NULL,
    "rows" INTEGER NOT NULL,
    "createdByIdentityId" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttachedAt" DATETIME,
    "detachedAt" DATETIME,
    "expiresAt" DATETIME,
    "endedAt" DATETIME,
    "endReason" TEXT,
    "errorCode" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TerminalSession_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TerminalSession_clientId_createdAt_idx" ON "TerminalSession" ("clientId", "createdAt");
CREATE INDEX "TerminalSession_clientId_status_idx" ON "TerminalSession" ("clientId", "status");

-- CreateTable: TerminalAuditEvent（终端最小审计）
CREATE TABLE "TerminalAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "identityId" TEXT,
    "actorName" TEXT,
    "source" TEXT,
    "result" TEXT NOT NULL DEFAULT 'ok',
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TerminalAuditEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TerminalSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TerminalAuditEvent_clientId_createdAt_idx" ON "TerminalAuditEvent" ("clientId", "createdAt");
CREATE INDEX "TerminalAuditEvent_sessionId_createdAt_idx" ON "TerminalAuditEvent" ("sessionId", "createdAt");
