-- RedefineTables：Release 由单归档（sha256/fileName/size）改为按平台归档（archives JSON）
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Release" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "archives" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "clientStates" TEXT NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "createdByName" TEXT,
    "createdVia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
-- 历史行均为 0.0.0 开发期产物，无平台归属信息，归档置空（不可再用于更新）
INSERT INTO "new_Release" ("id", "version", "archives", "status", "clientStates", "errorMessage", "createdByName", "createdVia", "createdAt", "updatedAt")
SELECT "id", "version", '{}', "status", "clientStates", "errorMessage", "createdByName", "createdVia", "createdAt", "updatedAt" FROM "Release";
DROP TABLE "Release";
ALTER TABLE "new_Release" RENAME TO "Release";
CREATE UNIQUE INDEX "Release_version_key" ON "Release"("version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
