import type React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PiAuditPanel } from "./pi-audit-panel.js";

const run = {
	runId: "r1",
	sessionId: "s1",
	status: "failed" as const,
	kind: "prompt" as const,
	executionMode: "supervised" as const,
	actorName: "User",
	source: "web",
	createdAt: "2026-10-08T00:00:00.000Z",
	acceptedAt: "2026-10-08T00:00:01.000Z",
	startedAt: "2026-10-08T00:00:01.000Z",
	finishedAt: "2026-10-08T00:00:05.000Z",
	errorCode: "PI_WORKER_EXITED" as const,
};

const audit = {
	id: "a1",
	sessionId: "s1",
	event: "execution_mode_changed" as const,
	result: "ok" as const,
	actorName: "User",
	source: "web",
	createdAt: "2026-10-08T00:00:00.000Z",
	errorCode: null,
	oldExecutionMode: "supervised" as const,
	newExecutionMode: "automatic" as const,
};

type PanelApi = React.ComponentProps<typeof PiAuditPanel>["pi"];

function makeApi(
	overrides: Partial<{
		runs: ReturnType<typeof vi.fn>;
		audit: ReturnType<typeof vi.fn>;
	}> = {},
): PanelApi {
	return {
		sessionsControl: {
			snapshot: vi.fn(),
			run: vi.fn(),
			archive: vi.fn(),
			restore: vi.fn(),
			runs: vi.fn(async () => ({ data: [run], total: 1, page: 1, pageSize: 20, totalPages: 1 })),
			audit: vi.fn(async () => ({ data: [audit], total: 1, page: 1, pageSize: 20, totalPages: 1 })),
			...overrides,
		},
	} as unknown as PanelApi;
}

describe("PiAuditPanel", () => {
	it("展示每轮执行摘要,不读取对话正文", async () => {
		const api = makeApi();
		render(<PiAuditPanel clientId="c1" sessionId="s1" pi={api} />);
		expect(await screen.findByText("PI_WORKER_EXITED")).toBeInTheDocument();
		expect(screen.getByText("失败")).toBeInTheDocument();
		expect(screen.getByText(/User ·/)).toBeInTheDocument();
		// 只读摘要:只调用 runs/audit 两个接口,不请求任何会话正文接口。
		expect(Object.keys(api.sessionsControl).sort()).toEqual([
			"archive",
			"audit",
			"restore",
			"run",
			"runs",
			"snapshot",
		]);
	});

	it("切换到会话操作页签并展示模式前后值", async () => {
		const api = makeApi();
		render(<PiAuditPanel clientId="c1" sessionId="s1" pi={api} />);
		await screen.findByText("PI_WORKER_EXITED");
		await userEvent.click(screen.getByRole("button", { name: "会话操作" }));
		expect(await screen.findByText("执行模式变更")).toBeInTheDocument();
		expect(screen.getByText("监督 → 自动")).toBeInTheDocument();
	});

	it("空结果展示明确空态;错误只显示安全信息", async () => {
		const empty = makeApi({
			runs: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
		});
		const { unmount } = render(<PiAuditPanel clientId="c1" sessionId="s1" pi={empty} />);
		expect(await screen.findByText("暂无执行记录")).toBeInTheDocument();
		unmount();

		const failing = makeApi({
			runs: vi.fn(async () => {
				throw new Error("not found");
			}),
		});
		render(<PiAuditPanel clientId="c1" sessionId="s1" pi={failing} />);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not found"));
	});
});
