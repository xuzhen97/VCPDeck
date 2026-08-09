import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { JobInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { DashboardPage } from "./dashboard-page.js";

function job(): JobInfo {
	return { jobId: "s1", clientId: "c1", clientName: "host", type: "agent.session", status: "idle" as JobInfo["status"], payload: { sessionId: "s1" }, result: null, progress: null, errorCode: null, errorMessage: null, createdAt: "2026-08-08T00:00:00.000Z", startedAt: null, finishedAt: null, createdByIdentityId: "i1", createdByName: "User", createdVia: "web" };
}

describe("DashboardPage", () => {
	it("展示 Pi 会话与空闲状态", async () => {
		const client = {
			auth: { me: vi.fn(async () => ({ id: "i1", username: "user", displayName: "User", isAdmin: true, disabledAt: null, createdAt: "2026-08-08T00:00:00.000Z" })) },
			clients: { list: vi.fn(async () => []) },
			jobs: { list: vi.fn(async () => ({ data: [job()], total: 1, page: 1, pageSize: 5, totalPages: 1 })) },
			frp: { list: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })) },
			aliyundrive: { status: vi.fn(async () => ({ authorized: false, configured: false })) },
		} as unknown as VcpDeckClient;
		render(<SdkProvider client={client}><AuthProvider><DashboardPage /></AuthProvider></SdkProvider>);
		expect(await screen.findByText("Pi 会话")).toBeVisible();
		expect(screen.getByText("空闲")).toBeVisible();
	});
});
