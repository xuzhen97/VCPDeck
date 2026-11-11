/**
 * Tailnet 凭据管理模块（ADR-0062）。
 *
 * 当前只注册凭据存储与状态机；REST 入口与 Job 绑定在后续任务接入。
 */
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { TailnetKeyService } from "./tailnet-key.service.js";
import { TailnetService } from "./tailnet.service.js";

@Module({
	imports: [PrismaModule],
	providers: [TailnetKeyService, TailnetService],
	exports: [TailnetKeyService, TailnetService],
})
export class TailnetModule {}
