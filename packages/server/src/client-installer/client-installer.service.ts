import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import {
	ReleaseStatus,
	VERSION,
	isReleaseArchiveAvailable,
	type ActorContext,
	type ReleasePlatform,
} from "@vcpdeck/shared";
import { ClientService } from "../client/client.service.js";
import { clientPsk } from "../client/client-psk.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReleaseService } from "../release/release.service.js";

const CONFIG_ID = "default";

const ClientInstallerErrorCode = {
	DISABLED: "CLIENT_INSTALLER_DISABLED",
	RELEASE_NOT_READY: "CLIENT_INSTALLER_RELEASE_NOT_READY",
	ARCHIVE_MISSING: "CLIENT_INSTALLER_ARCHIVE_MISSING",
	ASSET_MISSING: "CLIENT_INSTALLER_ASSET_MISSING",
	PSK_INVALID: "CLIENT_INSTALLER_PSK_INVALID",
} as const;
type ClientInstallerPlatform = ReleasePlatform;
export interface ClientInstallerConfigInfo {
	enabled: boolean;
	updatedAt: string | null;
	updatedByName: string | null;
	updatedVia: string | null;
	serverVersion: string;
	releaseReady: boolean;
	platforms: Record<ReleasePlatform, { available: boolean; reasonCode?: string }>;
}
export interface ClientInstallerPreflight {
	serverVersion: string;
	releaseVersion: string;
	platform: ReleasePlatform;
	archiveSize: number;
	installerUrl: string;
	installerSha256: string;
	lowLevelInstallerUrl: string;
	lowLevelInstallerSha256: string;
	nodeConstraint: string;
	nodeMirrors: string[];
	npmRegistries: string[];
}
export interface ClientInstallerBootstrap {
	serverVersion: string;
	releaseVersion: string;
	platform: ReleasePlatform;
	archiveUrl: string;
	archiveSha256: string;
	archiveSize: number;
	psk: string;
	verificationTimeoutMs: number;
}

const INSTALLER_ASSETS = [
	"install-client-bootstrap.sh",
	"install-client-bootstrap.ps1",
	"install-client.cjs",
	"install.cjs",
	"uninstall-client-bootstrap.sh",
	"uninstall-client-bootstrap.ps1",
	"uninstall-client.cjs",
] as const;

/** Client 安装领域错误。 */
export class ClientInstallerError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly statusCode: number,
	) {
		super(message);
	}
}

/** 管理一键安装开关、目标 Release、安装资产与 Client 验收。 */
@Injectable()
export class ClientInstallerService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(ReleaseService) private readonly releases: ReleaseService,
		@Inject(ClientService) private readonly clients: ClientService,
	) {}

	async getConfig(): Promise<ClientInstallerConfigInfo> {
		const [config, release] = await Promise.all([
			this.ensureConfig(),
			this.releases.findByVersion(VERSION),
		]);
		const releaseReady = release?.status === ReleaseStatus.DONE;
		return {
			enabled: config.enabled,
			updatedAt: config.updatedAt?.toISOString() ?? null,
			updatedByName: config.updatedByName,
			updatedVia: config.updatedVia,
			serverVersion: VERSION,
			releaseReady,
			platforms: {
				"win-x64": this.platformStatus(
					releaseReady,
					isReleaseArchiveAvailable(release?.archives["win-x64"]),
				),
				"linux-x64": this.platformStatus(
					releaseReady,
					isReleaseArchiveAvailable(release?.archives["linux-x64"]),
				),
			},
		};
	}

	async updateConfig(enabled: boolean, actor: ActorContext): Promise<ClientInstallerConfigInfo> {
		await this.ensureConfig();
		await this.prisma.$executeRawUnsafe(
			`UPDATE ClientInstallerConfig
			 SET enabled = ?, updatedByIdentityId = ?, updatedByName = ?, updatedVia = ?, updatedAt = CURRENT_TIMESTAMP
			 WHERE id = ?`,
			enabled ? 1 : 0,
			actor.identityId,
			actor.displayName,
			actor.source,
			CONFIG_ID,
		);
		return this.getConfig();
	}

	async preflight(platform: ClientInstallerPlatform): Promise<ClientInstallerPreflight> {
		const releasePlatform: ReleasePlatform = platform;
		const release = await this.requireReadyRelease(releasePlatform);
		const archive = release.archives[releasePlatform];
		if (!archive || !isReleaseArchiveAvailable(archive)) {
			throw new ClientInstallerError(
				ClientInstallerErrorCode.ARCHIVE_MISSING,
				`当前 Release 缺少可用的 ${releasePlatform} 构件`,
				409,
			);
		}
		const installer = this.readAsset("install-client.cjs");
		const lowLevelInstaller = this.readAsset("install.cjs");
		return {
			serverVersion: VERSION,
			releaseVersion: release.version,
			platform,
			archiveSize: archive.size,
			installerUrl: "/api/client-installer/assets/install-client.cjs",
			installerSha256: sha256(installer),
			lowLevelInstallerUrl: "/api/client-installer/assets/install.cjs",
			lowLevelInstallerSha256: sha256(lowLevelInstaller),
			nodeConstraint: ">=24",
			nodeMirrors: ["https://npmmirror.com/mirrors/node", "https://nodejs.org/dist"],
			npmRegistries: ["https://registry.npmmirror.com", "https://registry.npmjs.org"],
		};
	}

	async bootstrap(platform: ClientInstallerPlatform): Promise<ClientInstallerBootstrap> {
		const releasePlatform: ReleasePlatform = platform;
		const release = await this.requireReadyRelease(releasePlatform);
		const archive = release.archives[releasePlatform];
		if (!archive || !isReleaseArchiveAvailable(archive)) {
			throw new ClientInstallerError(
				ClientInstallerErrorCode.ARCHIVE_MISSING,
				`当前 Release 缺少可用的 ${releasePlatform} 构件`,
				409,
			);
		}
		return {
			serverVersion: VERSION,
			releaseVersion: release.version,
			platform,
			archiveUrl: `/api/releases/${encodeURIComponent(release.version)}/file?platform=${platform}`,
			archiveSha256: archive.sha256,
			archiveSize: archive.size,
			psk: clientPsk(),
			verificationTimeoutMs: 120_000,
		};
	}

	readAsset(name: (typeof INSTALLER_ASSETS)[number]): Buffer {
		const root = installerAssetsDir();
		const path = resolve(root, name);
		if (!path.startsWith(`${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`) || !existsSync(path)) {
			throw new ClientInstallerError(
				ClientInstallerErrorCode.ASSET_MISSING,
				`安装资产 ${name} 不存在`,
				503,
			);
		}
		return readFileSync(path);
	}

	async getClientStatus(clientId: string) {
		await this.requireEnabled();
		return this.clients.getInstallerStatus(clientId);
	}

	async renameClient(clientId: string, name: string) {
		await this.requireEnabled();
		return this.clients.rename(clientId, name);
	}

	assertPsk(value: string | undefined): void {
		if (!value || value !== clientPsk()) {
			throw new ClientInstallerError(
				ClientInstallerErrorCode.PSK_INVALID,
				"Client 安装凭据无效",
				401,
			);
		}
	}

	private async requireReadyRelease(platform: ReleasePlatform) {
		await this.requireEnabled();
		const release = await this.releases.findByVersion(VERSION);
		if (!release || release.status !== ReleaseStatus.DONE) {
			throw new ClientInstallerError(
				ClientInstallerErrorCode.RELEASE_NOT_READY,
				"当前 Server 版本没有已完成的 Release",
				409,
			);
		}
		if (!isReleaseArchiveAvailable(release.archives[platform])) {
			throw new ClientInstallerError(
				ClientInstallerErrorCode.ARCHIVE_MISSING,
				`当前 Release 缺少可用的 ${platform} 构件`,
				409,
			);
		}
		return release;
	}

	private async requireEnabled(): Promise<void> {
		const config = await this.ensureConfig();
		if (!config.enabled) {
			throw new ClientInstallerError(
				ClientInstallerErrorCode.DISABLED,
				"Server 已关闭 Client 一键安装",
				403,
			);
		}
	}

	private async ensureConfig(): Promise<{
		enabled: boolean;
		updatedAt: Date | null;
		updatedByName: string | null;
		updatedVia: string | null;
	}> {
		await this.prisma.$executeRawUnsafe(
			`INSERT OR IGNORE INTO ClientInstallerConfig (id, enabled, createdAt, updatedAt)
			 VALUES (?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
			CONFIG_ID,
		);
		const rows = await this.prisma.$queryRawUnsafe<Array<{
			enabled: number | boolean;
			updatedAt: Date | string | null;
			updatedByName: string | null;
			updatedVia: string | null;
		}>>(
			`SELECT enabled, updatedAt, updatedByName, updatedVia
			 FROM ClientInstallerConfig WHERE id = ? LIMIT 1`,
			CONFIG_ID,
		);
		const row = rows[0];
		if (!row) throw new Error("ClientInstallerConfig 初始化失败");
		return {
			enabled: Boolean(row.enabled),
			updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
			updatedByName: row.updatedByName,
			updatedVia: row.updatedVia,
		};
	}

	private platformStatus(releaseReady: boolean, hasArchive: boolean) {
		if (!releaseReady) {
			return { available: false, reasonCode: ClientInstallerErrorCode.RELEASE_NOT_READY };
		}
		if (!hasArchive) {
			return { available: false, reasonCode: ClientInstallerErrorCode.ARCHIVE_MISSING };
		}
		return { available: true };
	}
}

/** 定位随 Server 发布或仓库开发环境提供的安装资产目录。 */
export function installerAssetsDir(): string {
	const candidates = [
		join(__dirname, "..", "installer"),
		join(__dirname, "..", "..", "installer"),
		join(__dirname, "..", "..", "..", "scripts"),
		join(__dirname, "..", "..", "..", "..", "scripts"),
	];
	return candidates.find((path) => existsSync(join(path, "install-client.cjs"))) ?? candidates[0] ?? "";
}

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
