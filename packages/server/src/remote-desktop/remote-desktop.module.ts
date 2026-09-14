import { Module } from "@nestjs/common";
import { RemoteDesktopAuditService } from "./remote-desktop-audit.service.js";
import { RemoteDesktopController } from "./remote-desktop.controller.js";
import { RemoteDesktopRequestBroker } from "./remote-desktop-request-broker.js";
import { RemoteDesktopService } from "./remote-desktop.service.js";
import { RemoteDesktopSignalingService } from "./remote-desktop-signaling.service.js";
import { RemoteDesktopIceConfigService } from "./ice-config.service.js";

/** 浏览器远程桌面控制面模块：REST 会话、最小审计、ICE 配置和 Client 请求代理。 */
@Module({
	controllers: [RemoteDesktopController],
	providers: [
		RemoteDesktopService,
		RemoteDesktopRequestBroker,
		RemoteDesktopAuditService,
		RemoteDesktopSignalingService,
		RemoteDesktopIceConfigService,
	],
	exports: [
		RemoteDesktopService,
		RemoteDesktopRequestBroker,
		RemoteDesktopAuditService,
		RemoteDesktopSignalingService,
		RemoteDesktopIceConfigService,
	],
})
export class RemoteDesktopModule {}
