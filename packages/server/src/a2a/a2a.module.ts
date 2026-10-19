import { Module } from "@nestjs/common";
import { AgentRegistryModule } from "../agent-registry/agent-registry.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { TaskModule } from "../task/task.module.js";
import { A2aController } from "./a2a.controller.js";
import { A2aService } from "./a2a.service.js";

/** A2A facade：JSON-RPC 子集 + Agent Card；不暴露 ACP。 */
@Module({
	imports: [PrismaModule, AgentRegistryModule, TaskModule],
	controllers: [A2aController],
	providers: [A2aService],
	exports: [A2aService],
})
export class A2aModule {}
