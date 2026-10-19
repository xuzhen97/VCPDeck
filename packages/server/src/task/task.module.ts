import { Module } from "@nestjs/common";
import { AgentRegistryModule } from "../agent-registry/agent-registry.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { TaskController } from "./task.controller.js";
import { TaskAuditService } from "./task-audit.service.js";
import { TaskDeviationService } from "./task-deviation.service.js";
import { TaskDispatchService } from "./task-dispatch.service.js";
import { TaskService } from "./task.service.js";

/** Task 域模块；A2A controller 通过 TaskDispatchService 触发 Client。 */
@Module({
	imports: [PrismaModule, AgentRegistryModule],
	controllers: [TaskController],
	providers: [
		TaskService,
		TaskAuditService,
		TaskDeviationService,
		TaskDispatchService,
	],
	exports: [
		TaskService,
		TaskAuditService,
		TaskDeviationService,
		TaskDispatchService,
	],
})
export class TaskModule {}
