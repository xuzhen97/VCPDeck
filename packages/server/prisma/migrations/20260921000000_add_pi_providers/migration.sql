-- Pi Provider 配置扩展：保留 legacy provider 字段，严格回填显式 Provider 关系。
PRAGMA foreign_keys=OFF;

CREATE TABLE "PiProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "runtimeProviderId" TEXT NOT NULL,
    "protocol" TEXT,
    "baseUrl" TEXT,
    "headers" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "PiProviderModel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PiProviderModel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "PiProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PiProvider_name_key" ON "PiProvider"("name");
CREATE UNIQUE INDEX "PiProvider_runtimeProviderId_key" ON "PiProvider"("runtimeProviderId");
CREATE UNIQUE INDEX "PiProviderModel_providerId_modelId_key" ON "PiProviderModel"("providerId", "modelId");
CREATE INDEX "PiProviderModel_providerId_idx" ON "PiProviderModel"("providerId");

-- SQLite 没有稳定哈希函数；hex(provider) 是由旧 provider 值确定的、不猜测协议的稳定标识。
INSERT INTO "PiProvider" ("id", "name", "runtimeProviderId", "protocol", "baseUrl", "headers", "enabled", "revision", "createdAt", "updatedAt")
SELECT
  'legacy-' || lower(hex("provider")),
  'legacy-' || lower(hex("provider")),
  'legacy-' || lower(hex("provider")),
  NULL, NULL, '{}', false, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "provider" FROM "PiCredential");

-- SQLite 通过重建表添加非空外键，保留旧 provider、密文、指纹和生命周期字段。
CREATE TABLE "new_PiCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerConfigId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "fingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "new_PiCredential_providerConfigId_fkey" FOREIGN KEY ("providerConfigId") REFERENCES "PiProvider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PiCredential" ("id", "name", "provider", "providerConfigId", "ciphertext", "keyVersion", "fingerprint", "createdAt", "updatedAt", "lastUsedAt", "revokedAt")
SELECT "id", "name", "provider", 'legacy-' || lower(hex("provider")), "ciphertext", "keyVersion", "fingerprint", "createdAt", "updatedAt", "lastUsedAt", "revokedAt"
FROM "PiCredential";
DROP TABLE "PiCredential";
ALTER TABLE "new_PiCredential" RENAME TO "PiCredential";

CREATE UNIQUE INDEX "PiCredential_name_key" ON "PiCredential"("name");
CREATE INDEX "PiCredential_provider_idx" ON "PiCredential"("provider");
CREATE INDEX "PiCredential_providerConfigId_idx" ON "PiCredential"("providerConfigId");

PRAGMA foreign_keys=ON;
