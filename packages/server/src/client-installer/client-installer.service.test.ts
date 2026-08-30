import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ReleaseStatus,
	VERSION,
	type ReleaseArchiveInfo,
	type ReleasePlatform,
} from "@vcpdeck/shared";
import {
	ClientInstallerError,
	ClientInstallerService,
} from "./client-installer.service.js";

function release(status = ReleaseStatus.DONE) {
	const archives: Partial<Record<ReleasePlatform, ReleaseArchiveInfo>> = {
		"win-x64": { sha256: "a".repeat(64), size: 10, fileName: "win.zip" },
		"linux-x64": { sha256: "b".repeat(64), size: 20, fileName: "linux.zip" },
	};
	return {
		version: VERSION,
		status,
		archives,
		clientStates: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function mocks(enabled = false) {
	const rows = [
		{
			enabled: enabled ? 1 : 0,
			updatedAt: new Date("2026-08-20T00:00:00Z"),
			updatedByName: null,
			updatedVia: null,
		},
	];
	return {
		prisma: {
			$executeRawUnsafe: vi.fn(async () => 1),
			$queryRawUnsafe: vi.fn(async () => rows),
		},
		releases: { findByVersion: vi.fn(async () => release()) },
		clients: {
			getInstallerStatus: vi.fn(async () => ({ registered: true, online: true })),
			rename: vi.fn(),
		},
	};
}

describe("ClientInstallerService", () => {
	beforeEach(() => {
		process.env.VCPDECK_PSK = "test-shared-psk";
	});

	it("默认关闭但展示同版本平台 readiness", async () => {
		const { prisma, releases, clients } = mocks(false);
		const service = new ClientInstallerService(
			prisma as never,
			releases as never,
			clients as never,
		);
		const config = await service.getConfig();
		expect(config.enabled).toBe(false);
		expect(releases.findByVersion).toHaveBeenCalledWith(VERSION);
		expect(config.platforms["win-x64"].available).toBe(true);
	});

	it("关闭时 bootstrap fail closed 且不返回 PSK", async () => {
		const { prisma, releases, clients } = mocks(false);
		const service = new ClientInstallerService(
			prisma as never,
			releases as never,
			clients as never,
		);
		await expect(service.bootstrap("linux-x64")).rejects.toMatchObject({
			code: "CLIENT_INSTALLER_DISABLED",
			statusCode: 403,
		});
	});

	it("启用时只返回当前 Server 同版本 done Release", async () => {
		const { prisma, releases, clients } = mocks(true);
		const service = new ClientInstallerService(
			prisma as never,
			releases as never,
			clients as never,
		);
		const result = await service.bootstrap("win-x64");
		expect(result).toMatchObject({
			serverVersion: VERSION,
			releaseVersion: VERSION,
			platform: "win-x64",
			psk: "test-shared-psk",
		});
	});

	it("Release 未完成或平台缺包时拒绝", async () => {
		const { prisma, releases, clients } = mocks(true);
		const service = new ClientInstallerService(
			prisma as never,
			releases as never,
			clients as never,
		);
		releases.findByVersion.mockResolvedValueOnce(release(ReleaseStatus.UPLOADED));
		await expect(service.bootstrap("win-x64")).rejects.toBeInstanceOf(
			ClientInstallerError,
		);
		releases.findByVersion.mockResolvedValueOnce({ ...release(), archives: {} });
		await expect(service.bootstrap("win-x64")).rejects.toMatchObject({
			code: "CLIENT_INSTALLER_ARCHIVE_MISSING",
		});
	});

	it("cleaned archive 不再被视为可安装构件", async () => {
		const { prisma, releases, clients } = mocks(true);
		const service = new ClientInstallerService(
			prisma as never,
			releases as never,
			clients as never,
		);
		releases.findByVersion.mockResolvedValueOnce({
			...release(),
			archives: {
				...release().archives,
				"win-x64": {
					sha256: "a".repeat(64),
					size: 10,
					fileName: "win.zip",
					availability: "cleaned",
					cleanedAt: "2026-08-29T00:00:00.000Z",
					cleanupReason: "retention_policy",
				},
			},
		});
		await expect(service.bootstrap("win-x64")).rejects.toMatchObject({
			code: "CLIENT_INSTALLER_ARCHIVE_MISSING",
		});
	});

	it("公开 Shell 安装资产统一使用 LF", () => {
		const { prisma, releases, clients } = mocks(true);
		const service = new ClientInstallerService(
			prisma as never,
			releases as never,
			clients as never,
		);
		for (const name of [
			"install-client-bootstrap.sh",
			"uninstall-client-bootstrap.sh",
		] as const) {
			expect(service.readAsset(name).includes(0x0d)).toBe(false);
		}
	});

	it("验收接口要求正确共享 PSK", () => {
		const { prisma, releases, clients } = mocks(true);
		const service = new ClientInstallerService(
			prisma as never,
			releases as never,
			clients as never,
		);
		expect(() => service.assertPsk("wrong")).toThrowError(ClientInstallerError);
		expect(() => service.assertPsk("test-shared-psk")).not.toThrow();
	});
});
