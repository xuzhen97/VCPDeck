-- CreateTable: FrpsInstance
CREATE TABLE "FrpsInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "serverAddr" TEXT NOT NULL,
    "serverPort" INTEGER NOT NULL DEFAULT 7000,
    "authToken" TEXT NOT NULL DEFAULT '',
    "dashboardScheme" TEXT NOT NULL DEFAULT 'http',
    "dashboardHost" TEXT,
    "dashboardPort" INTEGER NOT NULL DEFAULT 7500,
    "dashboardUser" TEXT NOT NULL DEFAULT 'admin',
    "dashboardPassword" TEXT NOT NULL DEFAULT 'admin',
    "portRangeStart" INTEGER NOT NULL DEFAULT 20000,
    "portRangeEnd" INTEGER NOT NULL DEFAULT 21000,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- AlterTable: FrpMapping add frpsInstanceId
ALTER TABLE "FrpMapping" ADD COLUMN "frpsInstanceId" TEXT;
CREATE INDEX "FrpMapping_frpsInstanceId_fkey" ON "FrpMapping" (
    "frpsInstanceId"
);
