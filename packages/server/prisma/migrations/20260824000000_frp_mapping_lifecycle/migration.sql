-- FRP 映射写操作保留控制面状态，直到 FRPS Dashboard 确认完成。
ALTER TABLE "FrpMapping" ADD COLUMN "operationJobId" TEXT;
ALTER TABLE "FrpMapping" ADD COLUMN "operationTimeoutSeconds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "FrpMapping" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "FrpMapping" ADD COLUMN "errorMessage" TEXT;

-- 旧数据允许同一实例重名；保留第一条，其他记录追加稳定 mapping id 后缀。
UPDATE "FrpMapping"
SET "name" = "name" || '-' || "id"
WHERE EXISTS (
    SELECT 1
    FROM "FrpMapping" AS "earlier"
    WHERE
        "earlier"."frpsInstanceId" = "FrpMapping"."frpsInstanceId"
        AND "earlier"."name" = "FrpMapping"."name"
        AND "earlier"."id" < "FrpMapping"."id"
);

CREATE UNIQUE INDEX "FrpMapping_frpsInstanceId_name_key"
ON "FrpMapping" ("frpsInstanceId", "name");
