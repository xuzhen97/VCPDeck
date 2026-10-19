import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import { TaskDeviationService } from "./task-deviation.service.js";

function makeService(options: {
	constraints?: Record<string, unknown>;
	artifacts?: string[];
	events?: Array<Record<string, unknown>>;
}) {
	const prisma = {
		task: {
			findUnique: vi.fn(async () => ({
				id: "t1",
				constraints: JSON.stringify(options.constraints ?? {}),
				artifacts: (options.artifacts ?? []).map((name) => ({ name })),
			})),
		},
		taskEvent: {
			findMany: vi.fn(async () => options.events ?? []),
		},
	} as unknown as PrismaService;
	const audit = { record: vi.fn(async () => undefined) };
	return {
		service: TaskDeviationService.withDeps({ prisma, audit }),
		prisma,
		audit,
	};
}

describe("TaskDeviationService", () => {
	it("tool path 越界判 drifted", async () => {
		const { service } = makeService({
			constraints: { allowedPaths: ["src/"] },
			events: [
				{
					event: "tool_call",
					data: JSON.stringify({ locations: [{ path: "/etc/passwd" }] }),
				},
			],
		});
		await expect(service.check("t1")).resolves.toMatchObject({
			verdict: "drifted",
			reasons: ["PATH_OUTSIDE_CONSTRAINT"],
		});
	});

	it("缺少 requiredArtifacts 判 drifted", async () => {
		const { service } = makeService({
			constraints: { requiredArtifacts: ["report"] },
			artifacts: [],
		});
		await expect(service.check("t1")).resolves.toMatchObject({
			verdict: "drifted",
			reasons: ["MISSING_ARTIFACT"],
		});
	});
});
