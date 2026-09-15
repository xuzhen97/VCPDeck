import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { TunnelConfigService } from "./tunnel-config.service.js";
import { TunnelSessionService } from "./tunnel-session.service.js";
import { TunnelController } from "./tunnel.controller.js";

/** P2P 隧道：ICE/coturn 配置、临时 Session 与 REST 控制面。 */
@Module({
	imports: [PrismaModule],
	providers: [TunnelConfigService, TunnelSessionService],
	exports: [TunnelConfigService, TunnelSessionService],
	controllers: [TunnelController],
})
export class TunnelModule {}
