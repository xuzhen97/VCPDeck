import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import { AgentRegistryService } from "./agent-registry.service.js";

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "ap-1",
		agentId: "reviewer",
		name: "Code Reviewer",
		adapter: "acp",
		clientId: "client-secret",
		command: "/usr/local/bin/dsh",
		args: "[\"--profile\",\"acp\"]",
		cwd: "/home/operator/repo",
		workspaceRoots: "[\"/home/operator/repo\"]",
		skills: "[\"review\"]",
		enabled: true,
		createdAt: new Date("2026-10-18T00:00:00.000Z"),
		updatedAt: new Date("2026-10-18T00:00:00.000Z"),
		...overrides,
	};
}

function makeService(rows = [row()]) {
	const prisma = {
		client: {
			findUnique: vi.fn(async () => ({ id: "client-secret" })),
		},
		agentPlacement: {
			findMany: vi.fn(async () => rows),
			findUnique: vi.fn(async () => rows[0] ?? null),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
				row({ ...data, id: "ap-created" }),
			),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
				row({ ...data }),
			),
			delete: vi.fn(async () => row()),
			count: vi.fn(async () => rows.length),
		},
		task: { count: vi.fn(async () => 0) },
	} as unknown as PrismaService;
	return {
		prisma,
		service: AgentRegistryService.withDeps({
			prisma,
			now: () => new Date("2026-10-18T00:00:00.000Z"),
		}),
	};
}

describe("AgentRegistryService", () => {
	it("同一 agentId 多 placement 时 fail closed", async () => {
		const { service } = makeService([row(), row({ id: "ap-2", clientId: "client-2" })]);
		await expect(service.resolve("reviewer")).rejects.toMatchObject({
			code: "AGENT_AMBIGUOUS",
		});
	});

	it("公开 Agent Card 不包含 clientId/command/cwd", async () => {
		const { service } = makeService();
		const card = await service.agentCard("https://deck.example");
		expect(card.supportedInterfaces[0]).toMatchObject({
			url: "https://deck.example/api/a2a",
			protocolBinding: "JSONRPC",
			protocolVersion: "1.0",
		});
		expect(card.capabilities.streaming).toBe(false);
		expect(JSON.stringify(card)).not.toContain("client-secret");
		expect(JSON.stringify(card)).not.toContain("/usr/local/bin/dsh");
		expect(JSON.stringify(card)).not.toContain("/home/operator/repo");
	});

	it("未知 Client 拒绝创建", async () => {
		const { service, prisma } = makeService();
		vi.mocked(prisma.client.findUnique).mockResolvedValueOnce(null);
		await expect(
			service.create(
				{
					agentId: "reviewer",
					name: "Code Reviewer",
					adapter: "acp",
					clientId: "missing",
					command: "dsh",
					args: ["--profile", "acp"],
					cwd: "/repo",
					workspaceRoots: ["/repo"],
				},
				null,
			),
		).rejects.toMatchObject({ code: "AGENT_CLIENT_UNKNOWN" });
	});

	it("列表返回分页结果并投影 skills", async () => {
		const { service } = makeService();
		const page = await service.list(1, 20);
		expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20 });
		expect(page.data[0]).toMatchObject({
			agentId: "reviewer",
			skills: ["review"],
			clientId: "client-secret",
		});
	});
});
