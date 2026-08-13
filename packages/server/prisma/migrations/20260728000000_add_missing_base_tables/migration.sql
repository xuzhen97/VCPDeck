-- 修复迁移历史：补齐此前仅通过 prisma db push 建立的表，
-- 使全新数据库可按迁移顺序回放（FrpMapping / Identity / Credential / AuthSession / StorageBackendConfig）。

-- AlterTable: Client 补齐 db push 时代添加的列（disks / cpuPercent / memPercent / runningJobs）
ALTER TABLE "Client" ADD COLUMN "disks" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Client" ADD COLUMN "cpuPercent" REAL;
ALTER TABLE "Client" ADD COLUMN "memPercent" REAL;
ALTER TABLE "Client" ADD COLUMN "runningJobs" TEXT NOT NULL DEFAULT '[]';

-- RedefineTables: Client 移除 init 时代遗留的 totalDiskMB（当前 schema 无此列）
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "cpuModel" TEXT NOT NULL,
    "totalMemMB" INTEGER NOT NULL,
    "clientVersion" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastHeartbeatAt" DATETIME,
    "connectedAt" DATETIME,
    "socketId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "disks" TEXT NOT NULL DEFAULT '[]',
    "cpuPercent" REAL,
    "memPercent" REAL,
    "runningJobs" TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO "new_Client" ("id", "hostname", "os", "cpuModel", "totalMemMB", "clientVersion", "capabilities", "online", "lastHeartbeatAt", "connectedAt", "socketId", "createdAt", "updatedAt", "disks", "cpuPercent", "memPercent", "runningJobs") SELECT "id", "hostname", "os", "cpuModel", "totalMemMB", "clientVersion", "capabilities", "online", "lastHeartbeatAt", "connectedAt", "socketId", "createdAt", "updatedAt", "disks", "cpuPercent", "memPercent", "runningJobs" FROM "Client";
DROP TABLE "Client";
ALTER TABLE "new_Client" RENAME TO "Client";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateTable: FrpMapping（含 frpsInstanceId，与 schema.prisma 一致；
-- 原 20260729000001_add_frps_instance 的 ALTER 在 Prisma 7 引擎下因漂移同步重复执行而失败，
-- 故将完整列定义下沉到此迁移，原迁移只创建 FrpsInstance）
CREATE TABLE "FrpMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "frpsInstanceId" TEXT,
    "name" TEXT NOT NULL,
    "proxyType" TEXT NOT NULL DEFAULT 'tcp',
    "localIp" TEXT NOT NULL DEFAULT '127.0.0.1',
    "localPort" INTEGER NOT NULL,
    "remotePort" INTEGER,
    "customDomain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "publicUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FrpMapping_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable: Identity
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "disabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Identity_username_key" ON "Identity" ("username");

-- CreateTable: Credential
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Credential_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Credential_tokenHash_key" ON "Credential" ("tokenHash");

-- CreateTable: AuthSession
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identityId" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthSession_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AuthSession_sessionHash_key" ON "AuthSession" ("sessionHash");

-- CreateTable: StorageBackendConfig
CREATE TABLE "StorageBackendConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL DEFAULT 'local',
    "config" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);
