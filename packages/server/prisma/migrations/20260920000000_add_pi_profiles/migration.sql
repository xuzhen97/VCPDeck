-- 远程 Pi 集中配置：PiProfile / PiCredential / PiProfileCredential / PiClientBinding
-- 权威边界见 docs/design/remote-pi-control-plane.md §6 与 ADR-0029。
-- 运行时由 Launcher preStart 的 prisma db push 应用（本文件用于审查与核对）。

CREATE TABLE "PiProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultProvider" TEXT NOT NULL,
    "defaultModelId" TEXT NOT NULL,
    "allowedModels" TEXT NOT NULL DEFAULT '[]',
    "defaultThinkingLevel" TEXT NOT NULL DEFAULT 'medium',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "PiCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "fingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME
);
CREATE TABLE "PiProfileCredential" (
    "profileId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,

    PRIMARY KEY ("profileId", "credentialId"),
    CONSTRAINT "PiProfileCredential_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PiProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PiProfileCredential_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "PiCredential" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "PiClientBinding" (
    "clientId" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PiClientBinding_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PiProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PiProfile_name_key" ON "PiProfile"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PiCredential_name_key" ON "PiCredential"("name");

-- CreateIndex
CREATE INDEX "PiCredential_provider_idx" ON "PiCredential"("provider");

-- CreateIndex
CREATE INDEX "PiClientBinding_profileId_idx" ON "PiClientBinding"("profileId");

