import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { TaskAuditService } from "./task-audit.service.js";
import { TaskDeviationService } from "./task-deviation.service.js";

@Controller("api/tasks")
export class TaskController {
	constructor(
		@Inject(TaskAuditService) private readonly audit: TaskAuditService,
		@Inject(TaskDeviationService) private readonly deviation: TaskDeviationService,
	) {}

	@Get(":id/events")
	async events(
		@Param("id") id: string,
		@Query("since") since?: string,
		@Query("limit") limit?: string,
	) {
		const sinceValue = Number(since);
		const limitValue = Number(limit);
		return this.audit.list(
			id,
			Number.isInteger(sinceValue) && sinceValue > 0 ? sinceValue : 0,
			Number.isInteger(limitValue) ? limitValue : 100,
		);
	}

	@Get(":id/deviation")
	async deviationOf(@Param("id") id: string) {
		return this.deviation.check(id);
	}
}
