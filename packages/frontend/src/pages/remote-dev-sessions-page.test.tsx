import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { RemoteDevSessionsPage } from "./remote-dev-sessions-page.js";

function session(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "rds_old",
		clientId: "c1",
		agentPlacementId: "p1",
		workspaceRoot: "D:\\repo",
		state: "closed",
		agentStatus: "exited",
		generationId: "g1",
		createdAt: "2026-10-19T00:00:00.000Z",
		updatedAt: "2026-10-19T01:00:00.000Z",
		closedAt: "2026-10-19T01:00:00.000Z",
		closeReason: "owner",
		cleanupStatus: "complete",
		acpSessionId: "acp-old",
		...overrides,
	};
}

function fakeSdk(rows: unknown[]) {
	return {
		clients: {
			list: vi
				.fn()
				.mockResolvedValue([
					{ clientId: "c1", name: "mylx", hostname: "xuzhen97-lx" },
				]),
		},
		remoteDev: {
			list: vi.fn().mockResolvedValue({
				data: rows,
				total: rows.length,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			}),
		},
	} as never;
}

function renderPage(sdk: never) {
	render(
		<SdkProvider client={sdk}>
			<MemoryRouter initialEntries={["/remote-dev/sessions"]}>
				<RemoteDevSessionsPage />
			</MemoryRouter>
		</SdkProvider>,
	);
}

describe("RemoteDevSessionsPage", () => {
	it("列出历史会话并给出继续入口", async () => {
		renderPage(fakeSdk([session()]));
		expect(await screen.findByText("rds_old")).toBeVisible();
		expect(screen.getByRole("link", { name: "继续" })).toHaveAttribute(
			"href",
			"/remote-dev/new?resumeFrom=rds_old",
		);
	});

	it("没有 ACP 上下文时不给继续入口", async () => {
		renderPage(fakeSdk([session({ acpSessionId: undefined })]));
		expect(await screen.findByText("rds_old")).toBeVisible();
		expect(screen.queryByRole("link", { name: "继续" })).toBeNull();
	});

	it("仍在运行的会话给打开入口", async () => {
		renderPage(
			fakeSdk([session({ state: "active", agentStatus: "ready", closedAt: undefined })]),
		);
		expect(await screen.findByText("rds_old")).toBeVisible();
		expect(screen.getByRole("link", { name: "打开" })).toHaveAttribute(
			"href",
			"/remote-dev/rds_old",
		);
		expect(screen.queryByRole("link", { name: "继续" })).toBeNull();
	});

	it("空列表给出创建引导", async () => {
		renderPage(fakeSdk([]));
		expect(await screen.findByText(/还没有开发会话/)).toBeVisible();
	});
});
