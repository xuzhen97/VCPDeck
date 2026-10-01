/**
 * Git SSH 共享密钥分发模块（ADR-0037 / ADR-0038）。
 *
 * 只注册管理面 REST 与分发编排；Socket 下发通道由 ClientGateway.afterInit 绑定。
 */
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { GitSshController } from "./git-ssh.controller.js";
import { GitSshService } from "./git-ssh.service.js";

@Module({
	imports: [PrismaModule],
	controllers: [GitSshController],
	providers: [GitSshService],
	exports: [GitSshService],
})
export class GitSshModule {}
