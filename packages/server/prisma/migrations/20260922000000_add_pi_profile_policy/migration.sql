-- Plan 2（docs/adr/0030）：PiProfile 新增工具策略与 Bundle 资源启用项。
-- 两列均可空：NULL = 未配置。
--   enabledResourceIds NULL → 无 Bundle 资源需求；
--   toolPolicyJson     NULL → 等价空策略（未出现在任何桶的工具默认拒绝）。
ALTER TABLE "PiProfile" ADD COLUMN "enabledResourceIds" TEXT;
ALTER TABLE "PiProfile" ADD COLUMN "toolPolicyJson" TEXT;
