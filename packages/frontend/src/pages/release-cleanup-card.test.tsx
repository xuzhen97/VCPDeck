import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { ReleaseCleanupCard } from "./release-cleanup-card.js";

function renderCard() {
	const api = {
		cleanupPreview: vi
			.fn()
			.mockResolvedValue({
				policy: {
					successfulReleaseCount: 3,
					minimumAgeDays: 30,
					uploadSessionGraceHours: 24,
				},
				candidates: [
					{
						version: "0.1.0",
						status: "failed",
							archives: [
								{ platform: "win-x64", bytes: 1024, providerState: "ready" },
								{
									platform: "linux-x64",
									bytes: 0,
									providerState: "provider_unavailable",
								},
							],
						bytes: 1024,
						reason: "retention_policy",
					},
				],
				expiredUploadSessions: { count: 2, bytes: 2048 },
				estimatedReclaimableBytes: 3072,
			}),
		cleanupRun: vi.fn().mockResolvedValue({
			startedAt: "2026-08-29T00:00:00.000Z",
			finishedAt: "2026-08-29T00:00:01.000Z",
			cleanedItems: 1,
			cleanedBytes: 1024,
			alreadyMissing: 0,
			failed: 0,
			skipped: 0,
			providerUnavailable: 1,
			retryable: false,
			issues: [],
		}),
	};
	const client = {
		auth: {
			me: vi.fn(async () => ({
				id: "i1",
				username: "user",
				displayName: "User",
				isAdmin: true,
				disabledAt: null,
				createdAt: "2026-08-29T00:00:00.000Z",
			})),
		},
	} as unknown as VcpDeckClient;
	render(
		<SdkProvider client={client}>
			<AuthProvider>
				<ReleaseCleanupCard api={api as never} />
			</AuthProvider>
		</SdkProvider>,
	);
	return { api };
}

describe("ReleaseCleanupCard", () => {
	it("展示固定策略、候选和 Provider 不可用状态", async () => {
		const { api } = renderCard();

		expect(await screen.findByText(/最近 3 个成功版本/)).toBeVisible();
		expect(screen.getByText("0.1.0")).toBeVisible();
		expect(screen.getByText("Provider 不可用")).toBeVisible();
		expect(screen.getByText("预计回收")).toBeVisible();
		expect(screen.getByText("3.0 KB")).toBeVisible();
		expect(api.cleanupRun).not.toHaveBeenCalled();
	});

	it("点击清理先确认，确认后执行并刷新预览", async () => {
		const user = userEvent.setup();
		const { api } = renderCard();

		await screen.findByText("0.1.0");
		await user.click(screen.getByRole("button", { name: "立即按策略清理" }));
		expect(api.cleanupRun).not.toHaveBeenCalled();
		expect(screen.getByText(/只删除符合保留策略的归档正文/)).toBeVisible();

		await user.click(screen.getByRole("button", { name: "确认执行清理" }));
		await vi.waitFor(() => expect(api.cleanupRun).toHaveBeenCalledOnce());
		expect(api.cleanupPreview).toHaveBeenCalledTimes(2);
		expect(await screen.findByText(/本轮清理完成/)).toBeVisible();
	});
});
