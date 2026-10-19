import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

export interface TaskEventInput {
	taskId: string;
	turnId?: string;
	attemptId?: string;
	source: "a2a" | "acp" | "cli" | "human";
	event: string;
	fidelity: "structured" | "text" | "summary" | "hash-only";
	data?: unknown;
}

export interface TaskEventInfo {
	id: number;
	taskId: string;
	turnId?: string;
	attemptId?: string;
	at: string;
	source: string;
	event: string;
	fidelity: string;
	data?: unknown;
}

export interface TaskAuditDeps {
	prisma: PrismaService;
}

const MAX_EVENT_DATA_BYTES = 8 * 1024;

function parseData(value: string | null): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

/** Task 审计：append-only 元数据链；不保存正文、工具输出或终端内容。 */
@Injectable()
export class TaskAuditService {
	private readonly deps: TaskAuditDeps;

	constructor(@Inject(PrismaService) prisma: PrismaService) {
		this.deps = { prisma };
	}

	static withDeps(deps: TaskAuditDeps): TaskAuditService {
		const service = new TaskAuditService(null as unknown as PrismaService);
		(service as unknown as { deps: TaskAuditDeps }).deps = deps;
		return service;
	}

	async record(input: TaskEventInput): Promise<void> {
		let data: string | undefined;
		if (input.data !== undefined) {
			data = JSON.stringify(input.data);
			if (Buffer.byteLength(data, "utf8") > MAX_EVENT_DATA_BYTES) {
				data = JSON.stringify({ truncated: true });
			}
		}
		await this.deps.prisma.taskEvent.create({
			data: {
				taskId: input.taskId,
				...(input.turnId ? { turnId: input.turnId } : {}),
				...(input.attemptId ? { attemptId: input.attemptId } : {}),
				source: input.source,
				event: input.event,
				fidelity: input.fidelity,
				...(data ? { data } : {}),
			},
		});
	}

	async list(
		taskId: string,
		since = 0,
		limit = 100,
	): Promise<{ data: TaskEventInfo[]; nextSeq: number }> {
		const rows = await this.deps.prisma.taskEvent.findMany({
			where: { taskId, ...(since > 0 ? { id: { gt: since } } : {}) },
			orderBy: { id: "asc" },
			take: Math.min(200, Math.max(1, limit)),
		});
		const data = rows.map((row) => ({
			id: row.id,
			taskId: row.taskId,
			...(row.turnId ? { turnId: row.turnId } : {}),
			...(row.attemptId ? { attemptId: row.attemptId } : {}),
			at: row.at.toISOString(),
			source: row.source,
			event: row.event,
			fidelity: row.fidelity,
			data: parseData(row.data),
		}));
		return { data, nextSeq: data.at(-1)?.id ?? since };
	}
}
