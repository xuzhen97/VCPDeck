-- Plan 2.2（docs/adr/0033）：PiProfile 新增 Profile 级工具执行模式。
-- DEFAULT 'approval'：升级前 `confirm` 就是逐次审批，迁移不得扩大存量 Profile 的执行权限。
-- 合法值（approval / auto / yolo）由 Shared parser 与 Service 边界严格保证，不在数据库层枚举。
ALTER TABLE "PiProfile" ADD COLUMN "toolExecutionMode" TEXT NOT NULL DEFAULT 'approval';
