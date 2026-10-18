-- AddColumn: Client.annotations（ADR-0055）
-- 操作者声明的公网地址与备注；Server 持有，注册/心跳不得覆盖。
ALTER TABLE "Client" ADD COLUMN "annotations" TEXT NOT NULL DEFAULT '{}';
