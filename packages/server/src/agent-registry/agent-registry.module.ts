import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { AgentRegistryController } from "./agent-registry.controller.js";
import { AgentRegistryService } from "./agent-registry.service.js";

/** Agent placement 注册表；不是 Feature Registry，也不是 agent 账号表。 */
@Module({
	imports: [PrismaModule],
	controllers: [AgentRegistryController],
	providers: [AgentRegistryService],
	exports: [AgentRegistryService],
})
export class AgentRegistryModule {}
