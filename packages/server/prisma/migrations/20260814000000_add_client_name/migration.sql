-- AlterTable: Client 增加别名列（可空 + 唯一索引；多行 NULL 不参与唯一约束，迁移前旧记录由注册流程自愈补齐）
ALTER TABLE "Client" ADD COLUMN "name" TEXT;
CREATE UNIQUE INDEX "Client_name_key" ON "Client"("name");
