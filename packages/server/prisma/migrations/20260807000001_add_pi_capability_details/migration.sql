-- 新增 Client Pi 能力详情字段（可选注册字段 capabilityDetails，JSON 文本）
ALTER TABLE "Client" ADD COLUMN "capabilityDetails" TEXT NOT NULL DEFAULT '{}';
