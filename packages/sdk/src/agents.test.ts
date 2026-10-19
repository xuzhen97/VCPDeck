import { describe, expect, it, vi } from "vitest";
import { createAgentsApi } from "./agents.js";

const emptyPage = {
	data: [],
	total: 0,
	page: 1,
	pageSize: 20,
	totalPages: 1,
};

describe("createAgentsApi", () => {
	it("list 走只读 /api/agents 并拼分页", async () => {
		const request = vi.fn().mockResolvedValue(emptyPage);
		const api = createAgentsApi({ request } as never);
		await api.list({ page: 2, pageSize: 10 });
		expect(request).toHaveBeenCalledWith(
			"GET",
			"/api/agents?page=2&pageSize=10",
			undefined,
			undefined,
		);
	});

	it("create 发 POST /api/agents 并透传 placement 输入", async () => {
		const created = { id: "a1", agentId: "dsh" };
		const request = vi.fn().mockResolvedValue(created);
		const api = createAgentsApi({ request } as never);
		const input = {
			agentId: "dsh",
			name: "DSH ACP",
			adapter: "acp" as const,
			clientId: "c1",
			command: "dsh",
			args: ["--profile", "acp"],
			cwd: "/repo",
			workspaceRoots: ["/repo"],
			enabled: true,
		};
		await expect(api.create(input)).resolves.toBe(created);
		expect(request).toHaveBeenCalledWith("POST", "/api/agents", input, undefined);
	});
});
