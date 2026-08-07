-- 重建 File 表：jobId 改为 nullable（Pi 附件在 Job 创建前上传），增加 purpose 字段（job / pi_prompt / pi_history）
CREATE TABLE "new_File" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "jobId" TEXT,
    "clientId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "storageKind" TEXT NOT NULL DEFAULT 'local',
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purpose" TEXT NOT NULL DEFAULT 'job'
);

-- 保留全部既有 File 行
INSERT INTO "new_File" (
    "id",
    "key",
    "jobId",
    "clientId",
    "filename",
    "mimeType",
    "size",
    "sha256",
    "status",
    "storageKind",
    "expiresAt",
    "createdAt"
)
SELECT
    "id",
    "key",
    "jobId",
    "clientId",
    "filename",
    "mimeType",
    "size",
    "sha256",
    "status",
    "storageKind",
    "expiresAt",
    "createdAt"
FROM "File";

DROP TABLE "File";
ALTER TABLE "new_File" RENAME TO "File";
CREATE UNIQUE INDEX "File_key_key" ON "File" ("key");
