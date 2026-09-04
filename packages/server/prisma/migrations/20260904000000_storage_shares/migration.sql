CREATE TABLE "StorageShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "fileId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT,
    "storageKind" TEXT NOT NULL,
    "createdByIdentityId" TEXT,
    "createdByName" TEXT,
    "createdVia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "revokedByIdentityId" TEXT,
    "invalidatedAt" DATETIME,
    "invalidReason" TEXT,
    CONSTRAINT "StorageShare_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StorageShare_tokenHash_key" ON "StorageShare"("tokenHash");
CREATE INDEX "StorageShare_fileId_idx" ON "StorageShare"("fileId");
