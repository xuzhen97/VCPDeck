import type { VcpDeckClient } from "@vcpdeck/sdk";
import {
	ReleaseClientState,
	ReleaseStatus,
	type ReleaseInfo,
} from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { ReleasesPage } from "./releases-page.js";

function release(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
	return {
		version: "1.2.1",
		sha256: "a".repeat(64),
		size: 1024,
		status: ReleaseStatus.DONE,
		errorMessage: null,
		createdAt: "2026-08-15T04:00:00.000Z",
		updatedAt: "2026-08-15T04:05:00.000Z",
		clientStates: {
			client_a: ReleaseClientState.DONE,
			client_b: ReleaseClientState.FAILED,
		},
		...overrides,
	};
}

function makeClient(releases: ReleaseInfo[]) {
	return {
		auth: {
			me: vi.fn(async () => ({
				id: "i1",
				username: "user",
				displayName: "User",
				isAdmin: true,
				disabledAt: null,
				createdAt: "2026-08-15T00:00:00.000Z",
			})),
		},
		releases: {
			list: vi.fn(async () => ({
				data: releases,
				total: releases.length,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			})),
			status: vi.fn(async () => ({
				serverVersion: "1.2.1",
				activeRelease: null,
			})),
		},
	} as unknown as VcpDeckClient;
}

describe("ReleasesPage", () => {
	it("展示服务端版本与发版记录（状态/客户端汇总）", async () => {
		const client = makeClient([
			release(),
			release({
				version: "1.2.0",
				status: ReleaseStatus.FAILED,
				errorMessage: "服务端更新失败: 控制通道不可用",
				clientStates: {},
			}),
		]);
		render(
			<SdkProvider client={client}>
				<AuthProvider>
					<ReleasesPage />
				</AuthProvider>
			</SdkProvider>,
		);

		expect((await screen.findAllByText("1.2.1")).length).toBeGreaterThan(0);
		expect(screen.getByText("完成")).toBeVisible();
		expect(screen.getByText("失败")).toBeVisible();
		// 客户端状态汇总
		expect(screen.getByText("成功 1 · 失败 1 · 进行中 0 · 待更新 0")).toBeVisible();
		expect(screen.getByText("尚未开始")).toBeVisible();
	});

	it("无发版记录时给出空态提示", async () => {
		const client = makeClient([]);
		render(
			<SdkProvider client={client}>
				<AuthProvider>
					<ReleasesPage />
				</AuthProvider>
			</SdkProvider>,
		);

		expect(await screen.findByText(/暂无发版记录/)).toBeVisible();
	});
});
