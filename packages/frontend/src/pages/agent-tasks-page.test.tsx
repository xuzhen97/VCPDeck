import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { A2aTask, IdentityInfo } from "@vcpdeck/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { AgentTasksPage } from "./agent-tasks-page";

const identity: IdentityInfo = {
	id: "i1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

const task = (overrides: Partial<A2aTask> = {}): A2aTask => ({
	id: "task_abc",
	contextId: "ctx_1",
	status: { state: "TASK_STATE_COMPLETED" },
	artifacts: [
		{ id: "a1", name: "agent-reply", mimeType: "text/markdown", uri: "task://x/reply/1" },
	],
	metadata: {
		vcpdeck: {
			agentId: "dsh",
			intent: "统计一下仓库里的 TODO",
			acceptanceCriteria: [],
			constraints: {},
			createdAt: "2026-10-20T12:00:00.000Z",
			updatedAt: "2026-10-20T12:01:00.000Z",
		},
	},
	...overrides,
});

function renderPage(
	overrides: {
		list?: () => Promise<unknown>;
		get?: () => Promise<unknown>;
		events?: () => Promise<unknown>;
	} = {},
) {
	const list = vi.fn(
		overrides.list ??
			(async () => ({
				tasks: [task()],
				nextPageToken: "",
				pageSize: 20,
				totalSize: 1,
			})),
	);
	const get = vi.fn(
		overrides.get ??
			(async (id: string) =>
				task({
					id,
					history: [
						{
							messageId: "m1",
							role: "user",
							parts: [{ text: "统计一下仓库里的 TODO" }],
						},
						{ messageId: "m2", role: "agent", parts: [{ text: "共 37 处 TODO" }] },
					],
				})),
	);
	const events = vi.fn(
		overrides.events ??
			(async () => ({
				data: [
					{
						id: 7,
						taskId: "task_abc",
						at: "2026-10-20T12:00:30.000Z",
						source: "a2a",
						event: "turn.outbound",
						fidelity: "text",
					},
				],
				nextSeq: 8,
			})),
	);
	const client = {
		auth: { me: async () => identity },
		tasks: { list, get, events },
	} as unknown as VcpDeckClient;
	render(
		<MemoryRouter>
			<SdkProvider client={client}>
				<AuthProvider>
					<AgentTasksPage />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
	return { list, get, events };
}

describe("AgentTasksPage", () => {
	it("列出 Agent 任务：任务号、目标 agent、意图、状态与产物数", async () => {
		renderPage();
		expect(await screen.findByText("task_abc")).toBeInTheDocument();
		const table = screen.getByRole("table", { name: "Agent 任务" });
		expect(within(table).getByText("dsh")).toBeInTheDocument();
		expect(within(table).getByText("统计一下仓库里的 TODO")).toBeInTheDocument();
		expect(within(table).getByText("已完成")).toBeInTheDocument();
		expect(within(table).getByText("1")).toBeInTheDocument();
		expect(
			screen.getByText((_, element) => {
				if (!element || element.tagName !== "P") return false;
				return (element.textContent ?? "").replace(/\s+/g, "") === "第1/1页·共1条";
			}),
		).toBeInTheDocument();
	});

	it("空列表给出派活指引，不假装有数据", async () => {
		renderPage({
			list: async () => ({
				tasks: [],
				nextPageToken: "",
				pageSize: 20,
				totalSize: 0,
			}),
		});
		expect(
			await screen.findByText(/暂无 Agent 任务/),
		).toBeInTheDocument();
	});

	it("详情抽屉回放 user 与 agent 双向正文、产物与事件", async () => {
		const user = userEvent.setup();
		const { get, events } = renderPage();
		await screen.findByText("task_abc");
		await user.click(screen.getByRole("button", { name: "详情" }));
		const drawer = await screen.findByRole("dialog", { name: "Agent 任务详情" });
		expect(within(drawer).getByText("共 37 处 TODO")).toBeInTheDocument();
		// 意图与 user 回合都展示同一句指令，出现两次是预期\n		expect(within(drawer).getAllByText("统计一下仓库里的 TODO")).toHaveLength(2);\n		expect(within(drawer).getByText("对话回放")).toBeInTheDocument();
		expect(within(drawer).getByText("agent-reply")).toBeInTheDocument();
		await waitFor(() => expect(events).toHaveBeenCalled());
		expect(await screen.findByText("turn.outbound")).toBeInTheDocument();
		expect(get).toHaveBeenCalledWith("task_abc", 50, expect.anything());
	});
});
