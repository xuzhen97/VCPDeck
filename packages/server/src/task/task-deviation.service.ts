import { Inject, Injectable } from "@nestjs/common";
import type { A2aTaskConstraints, ActorContext } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { TaskAuditService } from "./task-audit.service.js";

export type DeviationVerdict = "aligned" | "drifted" | "failed";

export interface TaskDeviationDeps {
	prisma: PrismaService;
	audit: Pick<TaskAuditService, "record">;
}

interface TaskDeviationRow {
	id: string;
	constraints: string;
	artifacts?: Array<{ name: string }>;
}

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathAllowed(path: string, allowed: string[]): boolean {
	const normalized = normalizePath(path);
	return allowed.some((prefix) => {
		const normalizedPrefix = normalizePath(prefix);
		return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
	});
}

/** 只用已持久化证据判断偏差；不做模型臆测，不把正文当证据。 */
@Injectable()
export class TaskDeviationService {
	private readonly deps: TaskDeviationDeps;

	constructor(
		@Inject(PrismaService) prisma: PrismaService,
		@Inject(TaskAuditService) audit: TaskAuditService,
	) {
		this.deps = { prisma, audit };
	}

	static withDeps(deps: TaskDeviationDeps): TaskDeviationService {
		const service = new TaskDeviationService(
			null as unknown as PrismaService,
			null as unknown as TaskAuditService,
		);
		(service as unknown as { deps: TaskDeviationDeps }).deps = deps;
		return service;
	}

	async check(
		taskId: string,
	): Promise<{ verdict: DeviationVerdict; reasons: string[] }> {
		const task = (await this.deps.prisma.task.findUnique({
			where: { id: taskId },
			include: { artifacts: true },
		})) as TaskDeviationRow | null;
		if (!task) {
			return { verdict: "failed", reasons: ["TASK_NOT_FOUND"] };
		}
		const constraints = parseJson<A2aTaskConstraints>(task.constraints, {});
		const events = await this.deps.prisma.taskEvent.findMany({
			where: { taskId },
			orderBy: { id: "asc" },
		});
		const reasons: string[] = [];
		const allowedPaths = constraints.allowedPaths ?? [];
		if (allowedPaths.length > 0) {
			for (const event of events) {
				if (event.event !== "tool_call" && event.event !== "tool_call_update") {
					continue;
				}
				const data = parseJson<{
					locations?: Array<{ path?: unknown }>;
				}>(event.data ?? "{}", {});
				for (const location of data.locations ?? []) {
					if (typeof location.path !== "string") continue;
					if (!pathAllowed(location.path, allowedPaths)) {
						if (!reasons.includes("PATH_OUTSIDE_CONSTRAINT")) {
							reasons.push("PATH_OUTSIDE_CONSTRAINT");
						}
					}
				}
			}
		}
		const required = constraints.requiredArtifacts ?? [];
		if (required.length > 0) {
			const names = new Set((task.artifacts ?? []).map((artifact) => artifact.name));
			for (const artifact of required) {
				if (!names.has(artifact)) {
					if (!reasons.includes("MISSING_ARTIFACT")) {
						reasons.push("MISSING_ARTIFACT");
					}
				}
			}
		}
		return { verdict: reasons.length > 0 ? "drifted" : "aligned", reasons };
	}

	async review(
		taskId: string,
		verdict: DeviationVerdict,
		_actor: ActorContext,
		note?: string,
	): Promise<void> {
		await this.deps.prisma.task.update({
			where: { id: taskId },
			data: { verdict },
		});
		await this.deps.audit.record({
			taskId,
			source: "human",
			event: "deviation.reviewed",
			fidelity: "summary",
			data: { verdict, ...(note ? { note: note.slice(0, 500) } : {}) },
		});
	}
}
