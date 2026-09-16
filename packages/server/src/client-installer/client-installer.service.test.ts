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

/** ADR-0027：构造 ClientInfo 形摘要（合规矩阵输入）。 */
function makeClient(overrides: {
	id: string;
	name: string;
	os: string;
	online: boolean;
	installation?: { mode: string };
	privileged?: { available: boolean; mode: string; nonInteractive: boolean; runAsUser: string };
} = { id: "c", name: "n", os: "linux 6.8", online: false }) {
	const capabilityDetails: Record<string, unknown> = {};
	if (overrides.privileged !== undefined) capabilityDetails.privileged = overrides.privileged;
	return {
		clientId: overrides.id,
		name: overrides.name,
		hostname: overrides.name,
		os: overrides.os,
		online: overrides.online,
		capabilityDetails,
		...(overrides.installation !== undefined ? { installation: overrides.installation } : {}),
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
			listAll: vi.fn(async () => [
				makeClient({
					id: "win-new",
					name: "win-new",
					os: "win32 10.0",
					online: true,
					installation: { mode: "windows-system-task" },
					privileged: { available: true, mode: "windows-system", nonInteractive: true, runAsUser: "SYSTEM" },
				}),
				makeClient({ id: "linux-old", name: "linux-old", os: "linux 6.8", online: false, installation: { mode: "legacy-pm2" } }),
				makeClient({ id: "unreported", name: "unreported", os: "win32 10.0", online: false }),
			]),
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

	it("preflight 按平台路由安装器资产：linux-x64 走 A2 systemd 安装器，win-x64 走 SYSTEM 开机任务安装器", async () => {
		const { prisma, releases, clients } = mocks(true);
		const service = new ClientInstallerService(
			prisma as never,
			releases as never,
			clients as never,
		);
		const linux = await service.preflight("linux-x64");
		expect(linux.installerUrl).toBe(
			"/api/client-installer/assets/install-client-linux.cjs",
		);
		const win = await service.preflight("win-x64");
		expect(win.installerUrl).toBe(
			"/api/client-installer/assets/install-client.cjs",
		);
		// 低层安装器两平台一致。
		expect(linux.lowLevelInstallerUrl).toBe(
			"/api/client-installer/assets/install.cjs",
		);
		expect(win.lowLevelInstallerUrl).toBe(
			"/api/client-installer/assets/install.cjs",
		);
	});

	describe("getConfig 迁移汇总（ADR-0027）", () => {
		it("包含离线 Client，独立于业务版本给出待人工升级原因", async () => {
			const { prisma, releases, clients } = mocks(false);
			const service = new ClientInstallerService(prisma as never, releases as never, clients as never);
			const config = await service.getConfig();
			expect(config.migration.compliantCount).toBe(1);
			expect(config.migration.needsUpgradeCount).toBe(2);
			const reasons = new Map(config.migration.clients.map((c) => [c.name, c.reason]));
			expect(reasons.get("linux-old")).toBe("legacy-pm2");
			expect(reasons.get("unreported")).toBe("installation-unreported");
			expect(config.migration.clients.find((c) => c.name === "linux-old")?.online).toBe(false);
		});

		it("全部 Client 合规时 needsUpgradeCount 为 0 且列表为空", async () => {
			const { prisma, releases, clients } = mocks(false);
			const compliant = [
				makeClient({
					id: "a",
					name: "a",
					os: "linux 6.8",
					online: true,
					installation: { mode: "systemd-root-equivalent" },
					privileged: { available: true, mode: "sudo-all", nonInteractive: true, runAsUser: "vcpdeck" },
				}),
			];
			clients.listAll.mockResolvedValue(compliant as never);
			const service = new ClientInstallerService(prisma as never, releases as never, clients as never);
			const config = await service.getConfig();
			expect(config.migration).toEqual({ compliantCount: 1, needsUpgradeCount: 0, clients: [] });
		});
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
