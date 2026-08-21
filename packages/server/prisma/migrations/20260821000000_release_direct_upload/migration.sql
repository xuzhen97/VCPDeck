CREATE TABLE "ReleaseUploadSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "providerUploadId" TEXT NOT NULL,
    "partSize" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdByIdentityId" TEXT,
    "createdByName" TEXT,
    "createdVia" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ReleaseUploadSession_version_platform_key"
ON "ReleaseUploadSession" ("version", "platform");

CREATE INDEX "ReleaseUploadSession_expiresAt_idx"
ON "ReleaseUploadSession" ("expiresAt");
