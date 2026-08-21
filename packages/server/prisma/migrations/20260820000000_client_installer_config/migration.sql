CREATE TABLE "ClientInstallerConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedByIdentityId" TEXT,
    "updatedByName" TEXT,
    "updatedVia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "ClientInstallerConfig" ("id", "enabled", "createdAt", "updatedAt")
VALUES ('default', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
