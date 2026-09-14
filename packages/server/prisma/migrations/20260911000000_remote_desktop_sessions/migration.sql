CREATE TABLE "RemoteDesktopSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "createdByIdentityId" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "selectedDisplayId" TEXT,
    "displaysJson" TEXT NOT NULL DEFAULT '[]',
    "qualityProfile" TEXT NOT NULL DEFAULT 'balanced',
    "clipboardMode" TEXT NOT NULL DEFAULT 'off',
    "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    "hostGeneration" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedAt" DATETIME,
    "detachedAt" DATETIME,
    "endedAt" DATETIME,
    "safeErrorCode" TEXT,
    "safeErrorMessage" TEXT,
    CONSTRAINT "RemoteDesktopSession_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client" (
        "id"
    ) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "RemoteDesktopAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "identityId" TEXT,
    "actorName" TEXT,
    "attachmentId" TEXT,
    "role" TEXT,
    "result" TEXT NOT NULL DEFAULT 'ok',
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RemoteDesktopAuditEvent_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "RemoteDesktopSession" (
        "id"
    ) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RemoteDesktopAuditEvent_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client" (
        "id"
    ) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "RemoteDesktopSession_clientId_status_idx"
ON "RemoteDesktopSession" ("clientId", "status");
CREATE INDEX "RemoteDesktopSession_clientId_createdAt_idx"
ON "RemoteDesktopSession" ("clientId", "createdAt");
CREATE INDEX "RemoteDesktopAuditEvent_clientId_createdAt_idx"
ON "RemoteDesktopAuditEvent" ("clientId", "createdAt");
CREATE INDEX "RemoteDesktopAuditEvent_sessionId_createdAt_idx"
ON "RemoteDesktopAuditEvent" ("sessionId", "createdAt");
