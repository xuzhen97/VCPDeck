import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// 退役校验：只关心路由解析结果，叶子页面用占位实现替换，避免把各面板依赖带进本测试。
vi.mock("@/auth-context", () => ({
	useAuth: () => ({
		phase: "authenticated",
		identity: {
			id: "identity-1",
			username: "operator",
			displayName: "操作员",
			isAdmin: true,
			disabledAt: null,
			createdAt: "2026-07-26T00:00:00.000Z",
		},
		logout: vi.fn(),
	}),
}));
vi.mock("@/pages/dashboard-page", () => ({
	DashboardPage: () => <p>dashboard-view</p>,
}));
vi.mock("@/pages/machine-workspace", () => ({
	MachineWorkspace: () => <p>machine-workspace-view</p>,
}));

import { AppRoutes } from "./routes.js";

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<AppRoutes />
		</MemoryRouter>,
	);
}

describe("AppRoutes 退役入口", () => {
	it("旧对话深链接走兜底，不再渲染 Agent", async () => {
		renderAt("/agent/chat");
		expect(await screen.findByText("dashboard-view")).toBeVisible();
		expect(screen.queryByText(/agent/i)).not.toBeInTheDocument();
	});

	it("旧 /pi 深链接走兜底", async () => {
		renderAt("/pi/profile");
		expect(await screen.findByText("dashboard-view")).toBeVisible();
	});

	it("机器旧 Pi 入口不再重定向到 Agent，而是留在机器工作区", async () => {
		renderAt("/machines/client-1/pi");
		expect(await screen.findByText("machine-workspace-view")).toBeVisible();
	});
});
