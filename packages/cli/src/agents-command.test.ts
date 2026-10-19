import { describe, expect, it, vi } from "vitest";
import { runAgentsCommand } from "./agents-command.js";

const placement = {
	id: "a1",
	agentId: "dsh",
	name: "DSH ACP",
	adapter: "acp",
	clientId: "c1",
	workspaceRoots: ["/repo"],
	skills: ["code"],
	enabled: true,
	createdAt: "2026-10-19T00:00:00.000Z",
	updatedAt: "2026-10-19T00:00:00.000Z",
};

function makeClient() {
	return {
		agents: {
			list: vi.fn().mockResolvedValue({
				data: [placement],
				total: 1,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			}),
			create: vi.fn().mockResolvedValue(placement),
		},
	};
}

function capture() {
	const lines: string[] = [];
	return { lines, log: (message: string) => lines.push(message) };
}

describe("vcpdeck agents", () => {
	it("list 输出表格与 JSON", async () => {
		const client = makeClient();
		const { lines, log } = capture();
		await runAgentsCommand("list", [], { sdk: client as never, log });
		expect(lines.join("\n")).toContain("dsh");
		expect(lines.join("\n")).toContain("DSH ACP");

		const json = capture();
		await runAgentsCommand("list", ["--json"], { sdk: client as never, log: json.log });
		expect(JSON.parse(json.lines.join(""))).toMatchObject({
			total: 1,
			data: [expect.objectContaining({ agentId: "dsh" })],
		});
	});

	it("create 解析重复 --arg/--workspace-root 并登记 placement", async () => {
		const client = makeClient();
		const { lines, log } = capture();
		const resolveClientIdFn = vi.fn(async () => "c1");
		await runAgentsCommand(
			"create",
			[
				"--client=Ozmo",
				"--agent=dsh",
				"--name=DSH ACP",
				"--command=dsh",
				"--arg=--profile",
				"--arg=acp",
				"--workspace-root=D:\\repo",
				"--cwd=D:\\repo",
				"--skill=code",
			],
			{ sdk: client as never, log, resolveClientIdFn },
		);
		expect(resolveClientIdFn).toHaveBeenCalledWith("Ozmo");
		expect(client.agents.create).toHaveBeenCalledWith({
			agentId: "dsh",
			name: "DSH ACP",
			adapter: "acp",
			clientId: "c1",
			command: "dsh",
			args: ["--profile", "acp"],
			cwd: "D:\\repo",
			workspaceRoots: ["D:\\repo"],
			skills: ["code"],
			enabled: true,
		});
		expect(lines.join("\n")).toContain("a1");
	});

	it("create 省略可选参数时给出安全默认值", async () => {
		const client = makeClient();
		await runAgentsCommand(
			"create",
			[
				"--client=c1",
				"--agent=reviewer",
				"--command=reviewer",
				"--workspace-root=/repo",
				"--disabled",
			],
			{ sdk: client as never, log: () => undefined, resolveClientIdFn: async () => "c1" },
		);
		expect(client.agents.create).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "reviewer",
				name: "reviewer",
				adapter: "acp",
				args: [],
				cwd: "/repo",
				workspaceRoots: ["/repo"],
				enabled: false,
			}),
		);
	});

	it("create 缺少必填项或未知子命令时给出用法", async () => {
		const client = makeClient();
		await expect(
			runAgentsCommand("create", ["--client=c1", "--agent=dsh"], {
				sdk: client as never,
				log: () => undefined,
				resolveClientIdFn: async () => "c1",
			}),
		).rejects.toThrow(/Agents 命令/);
		await expect(
			runAgentsCommand("ghost", [], { sdk: client as never, log: () => undefined }),
		).rejects.toThrow(/Agents 命令/);
	});
});
