import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import { TaskAuditService } from "./task-audit.service.js";

function makeService() {
	const events: Array<Record<string, unknown>> = [];
	const prisma = {
		taskEvent: {
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				const row = { ...data, id: events.length + 1, at: new Date() };
				events.push(row);
				return row;
			}),
			findMany: vi.fn(async () => events),
		},
	} as unknown as PrismaService;
	return { prisma, events, service: TaskAuditService.withDeps({ prisma }) };
}

describe("TaskAuditService", () => {
	it("append-only 记录并返回安全元数据", async () => {
		const { service, events } = makeService();
		await service.record({
			taskId: "t1",
			source: "acp",
			event: "tool_call",
			fidelity: "structured",
			data: { locations: [{ path: "src/a.ts" }] },
		});
		expect(events).toHaveLength(1);
		expect(await service.list("t1", 0, 10)).toMatchObject({
			nextSeq: 1,
			data: [expect.objectContaining({ event: "tool_call" })],
		});
	});
});
