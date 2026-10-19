import { Module } from "@nestjs/common";
import { AgentRegistryModule } from "../agent-registry/agent-registry.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { TerminalModule } from "../terminal/terminal.module.js";
import { RemoteDevAttachmentService } from "./remote-dev-attachment.service.js";
import { RemoteDevAuditService } from "./remote-dev-audit.service.js";
import { RemoteDevController } from "./remote-dev.controller.js";
import { RemoteDevForwardGateway } from "./remote-dev-forward.gateway.js";
import { RemoteDevPortService } from "./remote-dev-port.service.js";
import { RemoteDevService } from "./remote-dev.service.js";
import { RemoteDevTunnelGateway } from "./remote-dev-tunnel.gateway.js";
import { RdsRelay } from "./rds-relay.js";

/** Remote Dev Session 域：会话元数据、端口记录与轻量审计。 */
@Module({
	imports: [PrismaModule, AgentRegistryModule, TerminalModule],
	controllers: [RemoteDevController],
	providers: [
		RemoteDevService,
		RemoteDevAuditService,
		RemoteDevAttachmentService,
		RemoteDevPortService,
		RdsRelay,
		RemoteDevTunnelGateway,
		RemoteDevForwardGateway,
	],
	exports: [
		RemoteDevService,
		RemoteDevAuditService,
		RemoteDevAttachmentService,
		RemoteDevPortService,
		RemoteDevForwardGateway,
	],
})
export class RemoteDevModule {}
