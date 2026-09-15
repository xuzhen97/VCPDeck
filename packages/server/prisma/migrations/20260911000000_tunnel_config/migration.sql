CREATE TABLE "TunnelConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stunUrls" TEXT NOT NULL DEFAULT '[]',
    "turnUrls" TEXT NOT NULL DEFAULT '[]',
    "realm" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "TunnelConfig" ("id", "stunUrls", "turnUrls", "realm", "updatedAt")
VALUES ('default', '[]', '[]', '', CURRENT_TIMESTAMP);
