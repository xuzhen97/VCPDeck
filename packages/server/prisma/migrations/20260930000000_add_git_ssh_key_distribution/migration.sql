-- Git SSH 共享密钥分发：GitSshKey / GitSshTarget
-- 权威边界见 docs/adr/0037 与 docs/adr/0038。
-- 运行时由 Server 启动的 prisma db push 应用（本文件用于审查与核对）。
-- 只保存密文与安全元数据；私钥明文仅存在于 Server 受控解密窗口与获选 Client 的受管副本，
-- 且选机只是运维分发范围，不构成每机身份认证。

-- CreateTable
CREATE TABLE "GitSshKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GitSshTarget" (
    "clientId" TEXT NOT NULL PRIMARY KEY,
    "desiredVersion" INTEGER,
    "observedVersion" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "reasonCode" TEXT,
    "operationId" TEXT,
    "lastSentVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GitSshKey_version_key" ON "GitSshKey"("version");
