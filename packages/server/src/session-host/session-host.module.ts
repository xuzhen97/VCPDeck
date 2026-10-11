import { Module } from "@nestjs/common";
import { SessionHostService } from "./session-host.service.js";
import { SessionHostController } from "./session-host.controller.js";

/**
 * 会话宿主模块：对账服务 + 实例元数据 REST。
 *
 * PrismaModule 是 @Global，无需重复 import。
 * 旧 Terminal 模块与本模块并存且互不依赖：对账语义刻意不复用。
 */
@Module({
	providers: [SessionHostService],
	controllers: [SessionHostController],
	exports: [SessionHostService],
})
export class SessionHostModule {}
