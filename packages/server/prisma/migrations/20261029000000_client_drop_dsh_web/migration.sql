-- ADR-0061：退役远程 DSH WebUI 通道，Client 上的 DSH 登记与运行态字段不再使用。
ALTER TABLE "Client" DROP COLUMN "dshWebUrl";
ALTER TABLE "Client" DROP COLUMN "dshWebState";
ALTER TABLE "Client" DROP COLUMN "dshWebMode";
ALTER TABLE "Client" DROP COLUMN "dshWebPort";
ALTER TABLE "Client" DROP COLUMN "dshWebFrpMappingId";
