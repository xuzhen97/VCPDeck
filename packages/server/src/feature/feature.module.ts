/**
 * 功能目录模块（ADR-0056）。
 *
 * 只注册控制面 REST；不触碰 Client 注册协议，也不新增 Job 类型。
 */
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import {
	ClientFeatureController,
	FeatureController,
} from "./feature.controller.js";
import { FeatureService } from "./feature.service.js";

@Module({
	imports: [PrismaModule],
	controllers: [FeatureController, ClientFeatureController],
	providers: [FeatureService],
	exports: [FeatureService],
})
export class FeatureModule {}
