-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "cpuModel" TEXT NOT NULL,
    "totalMemMB" INTEGER NOT NULL,
    "totalDiskMB" INTEGER NOT NULL,
    "clientVersion" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastHeartbeatAt" DATETIME,
    "connectedAt" DATETIME,
    "socketId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "exitCode" INTEGER,
    "output" TEXT NOT NULL DEFAULT '',
    "timeout" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
