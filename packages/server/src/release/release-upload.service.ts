import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	ReleaseUploadErrorCode,
	parseReleaseUploadComplete,
	parseReleaseUploadCreateInput,
	parseReleaseUploadPartRefresh,
	type ActorContext,
	type ReleaseInfo,
	type ReleaseUploadCreateInput,
	type ReleaseUploadPart,
	type ReleaseUploadSession,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import {
	ReleaseError,
	ReleaseService,
	toPublicReleaseInfo,
	type ServerReleaseArchiveInfo,
} from "./release.service.js";
import { ReleaseOrchestrator } from "./release.orchestrator.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

/** Server Controller 使用的 Shared Release 上传 parser。 */
export const ReleaseUploadContract = {
	parseCreate: parseReleaseUploadCreateInput,
	parseRefresh: parseReleaseUploadPartRefresh,
	parseComplete: parseReleaseUploadComplete,
};
export type ReleaseUploadApiPart = ReleaseUploadPart;
export type ReleaseUploadApiSession = ReleaseUploadSession;

type ReleaseUploadSessionRow = {
	id: string;
	version: string;
	platform: string;
	sha256: string;
	size: number;
	provider: string;
	providerKey: string;
	providerUploadId: string;
	partSize: number;
	status: string;
	createdByName: string | null;
	createdVia: string | null;
	expiresAt: Date;
};

type ReleaseUploadSessionDelegate = {
	findUnique(args: {
		where:
			| { id: string }
			| { version_platform: { version: string; platform: string } };
	}): Promise<ReleaseUploadSessionRow | null>;
	create(args: {
		data: {
			id: string;
			version: string;
			platform: string;
			sha256: string;
			size: number;
			provider: string;
			providerKey: string;
			providerUploadId: string;
			partSize: number;
			status: string;
			createdByIdentityId: string | null;
			createdByName: string | null;
			createdVia: string | null;
			expiresAt: Date;
		};
	}): Promise<ReleaseUploadSessionRow>;
	delete(args: { where: { id: string } }): Promise<unknown>;
	update(args: {
		where: { id: string };
		data: { status: string };
	}): Promise<ReleaseUploadSessionRow>;
};

type PrismaWithReleaseUploadSession = PrismaService & {
	releaseUploadSession: ReleaseUploadSessionDelegate;
};

/** Release 直传会话领域错误。 */
export class ReleaseUploadError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ReleaseUploadError";
	}
}

/** Release 外部 Provider 直传会话、完成登记与编排入口。 */
@Injectable()
export class ReleaseUploadService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(StorageService) private readonly storage: StorageService,
		@Inject(ReleaseService) private readonly releases: ReleaseService,
		@Inject(ReleaseOrchestrator)
		private readonly orchestrator: ReleaseOrchestrator,
	) {}

	private get uploadSessions(): ReleaseUploadSessionDelegate {
		return (this.prisma as PrismaWithReleaseUploadSession).releaseUploadSession;
	}

	/** 协商上传模式；Alibaba 返回直传分片，Local 保留 Server 流式上传。 */
	async createSession(
		input: ReleaseUploadCreateInput,
		actor?: ActorContext,
	): Promise<ReleaseUploadApiSession> {
		const backend = await this.storage.getBackendConfig();
		if (backend.kind !== "alibaba") return { mode: "server" };

		const platform = input.platform as "win-x64" | "linux-x64";
		const existingRelease = await this.releases.findByVersion(input.version);
		const existingArchive = existingRelease?.archives[platform];
		if (existingArchive) {
			if (
				existingArchive.availability !== "deleting" &&
				existingArchive.availability !== "cleaned" &&
				existingArchive.sha256 === input.sha256 &&
				existingArchive.size === input.size
			) {
				return { mode: "existing", release: existingRelease as ReleaseInfo };
			}
			throw new ReleaseError(
				"RELEASE_ARCHIVE_EXISTS",
				`release ${input.version} 已存在 ${input.platform} 构件`,
			);
		}

		const existing = await this.uploadSessions.findUnique({
			where: {
				version_platform: {
					version: input.version,
					platform: input.platform,
				},
			},
		});
		if (existing) {
			if (
				existing.sha256 !== input.sha256 ||
				existing.size !== input.size ||
				existing.provider !== "alibaba"
			) {
				throw new ReleaseUploadError(
					ReleaseUploadErrorCode.SESSION_CONFLICT,
					"同版本平台已有不同构件的上传会话",
				);
			}
			if (
				existing.status === "completed" ||
				existing.status === "provider_completed"
			) {
				throw new ReleaseUploadError(
					ReleaseUploadErrorCode.SESSION_CONFLICT,
					existing.status === "completed"
						? "上传会话已经完成"
						: "上传会话已完成 Provider 合并，请继续完成登记",
				);
			}
			if (existing.expiresAt.getTime() > Date.now()) {
				return this.resumeSession(existing);
			}
			await this.providerCall(() => this.storage.delete(existing.providerKey));
			await this.uploadSessions.delete({ where: { id: existing.id } });
		}

		const fileName = this.fileName(input.version, input.platform);
		const provider = await this.providerCall(() =>
			this.storage.createReleaseDirectUpload(input.size, fileName),
		);
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
		const row = await this.uploadSessions.create({
			data: {
				id: randomUUID(),
				version: input.version,
				platform: input.platform,
				sha256: input.sha256,
				size: input.size,
				provider: "alibaba",
				providerKey: provider.fileId,
				providerUploadId: provider.uploadId,
				partSize: provider.partSize,
				status: "pending",
				createdByIdentityId: actor?.identityId ?? null,
				createdByName: actor?.displayName ?? null,
				createdVia: actor?.source ?? null,
				expiresAt,
			},
		});
		return {
			mode: "direct",
			sessionId: row.id,
			partSize: row.partSize,
			parts: provider.parts,
			expiresAt: row.expiresAt.toISOString(),
		};
	}

	/** 刷新指定分片 URL；URL 只返回调用方，不持久化。 */
	async refreshParts(
		sessionId: string,
		partNumbers: number[],
	): Promise<{ parts: ReleaseUploadPart[] }> {
		const row = await this.requirePendingSession(sessionId);
		this.assertPartNumbers(row.size, row.partSize, partNumbers);
		const parts = await this.providerCall(() =>
			this.storage.refreshReleaseDirectUploadParts(
				row.providerKey,
				row.providerUploadId,
				partNumbers,
			),
		);
		if (parts.length !== partNumbers.length) {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.SESSION_CONFLICT,
				"Provider 未返回全部请求分片",
			);
		}
		return { parts };
	}

	/** 完成 Provider 分片合并并登记 Release；重复完成幂等返回已登记 Release。 */
	async completeSession(
		sessionId: string,
		uploadedBytes: number,
	): Promise<{ release: ReleaseInfo }> {
		const row = await this.uploadSessions.findUnique({
			where: { id: sessionId },
		});
		if (!row) {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.SESSION_NOT_FOUND,
				"Release 上传会话不存在",
			);
		}
		if (uploadedBytes !== row.size) {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.SIZE_MISMATCH,
				"上传字节数与创建会话时声明值不一致",
			);
		}
		const already = await this.releases.findByVersionWithStorage(row.version);
		const platform = row.platform as "win-x64" | "linux-x64";
		const registered = already?.archives[platform];
		if (row.status === "completed" || registered) {
			if (!already || !registered) {
				throw new ReleaseUploadError(
					ReleaseUploadErrorCode.SESSION_CONFLICT,
					"上传会话与已登记 Release 构件不一致",
				);
			}
			if (
				registered.availability === "deleting" ||
				registered.availability === "cleaned" ||
				registered.sha256 !== row.sha256 ||
				registered.size !== row.size ||
				registered.storage?.key !== row.providerKey
			) {
				throw new ReleaseUploadError(
					ReleaseUploadErrorCode.SESSION_CONFLICT,
					"上传会话与已登记 Release 构件不一致",
				);
			}
			if (row.status !== "completed") {
				await this.markCompleted(row.id, toPublicReleaseInfo(already));
			}
			return { release: toPublicReleaseInfo(already) };
		}
		if (row.status !== "provider_completed") {
			this.assertNotExpired(row.expiresAt);

			// Provider 创建上传任务时已固定总大小；CLI 完成上报也必须与会话大小一致。
			// 构件内容完整性由 Launcher 下载后的独立 SHA-256 复核兜底。
			await this.providerCall(() =>
				this.storage.completeReleaseDirectUpload(
					row.providerKey,
					row.providerUploadId,
				),
			);
			await this.markProviderCompleted(row.id);
		}
		const archive: ServerReleaseArchiveInfo = {
			sha256: row.sha256,
			size: row.size,
			fileName: this.fileName(row.version, platform),
			availability: "available",
			storage: {
				provider: row.provider,
				key: row.providerKey,
				mode: "direct",
			},
		};
		const current = await this.releases.findByVersionWithStorage(row.version);
		let release: ReleaseInfo;
		if (current?.archives[platform]) {
			const stored = current.archives[platform];
			if (
				stored.availability === "deleting" ||
				stored.availability === "cleaned" ||
				stored.sha256 !== archive.sha256 ||
				stored.size !== archive.size ||
				stored.storage?.key !== archive.storage?.key
			) {
				throw new ReleaseUploadError(
					ReleaseUploadErrorCode.SESSION_CONFLICT,
					"Release 已登记不同构件",
				);
			}
			release = toPublicReleaseInfo(current);
		} else {
			release = current
				? await this.releases.addArchive(row.version, platform, archive)
				: await this.releases.create({
						version: row.version,
						archives: { [platform]: archive },
						createdByName: row.createdByName ?? undefined,
						createdVia: row.createdVia ?? undefined,
					});
		}
		await this.markCompleted(row.id, release);
		return { release };
	}

	private async resumeSession(row: {
		id: string;
		size: number;
		partSize: number;
		providerKey: string;
		providerUploadId: string;
		expiresAt: Date;
	}): Promise<ReleaseUploadApiSession> {
		const partNumbers = Array.from(
			{ length: Math.ceil(row.size / row.partSize) },
			(_, index) => index + 1,
		);
		const parts = await this.providerCall(() =>
			this.storage.refreshReleaseDirectUploadParts(
				row.providerKey,
				row.providerUploadId,
				partNumbers,
			),
		);
		if (parts.length !== partNumbers.length) {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.SESSION_CONFLICT,
				"Provider 未返回全部上传分片",
			);
		}
		return {
			mode: "direct",
			sessionId: row.id,
			partSize: row.partSize,
			parts,
			expiresAt: row.expiresAt.toISOString(),
		};
	}

	private async requirePendingSession(sessionId: string) {
		const row = await this.uploadSessions.findUnique({
			where: { id: sessionId },
		});
		if (!row) {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.SESSION_NOT_FOUND,
				"Release 上传会话不存在",
			);
		}
		if (row.status !== "pending") {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.SESSION_CONFLICT,
				"Release 上传会话不可刷新",
			);
		}
		this.assertNotExpired(row.expiresAt);
		return row;
	}

	private async markProviderCompleted(sessionId: string): Promise<void> {
		await this.uploadSessions.update({
			where: { id: sessionId },
			data: { status: "provider_completed" },
		});
	}

	private async markCompleted(
		sessionId: string,
		release: ReleaseInfo,
	): Promise<void> {
		await this.uploadSessions.update({
			where: { id: sessionId },
			data: { status: "completed" },
		});
		if (this.releases.hasAllArchives(release)) {
			void this.orchestrator.startRelease(release.version).catch(
				(error: unknown) => {
					console.error("[release] 触发更新失败", release.version, error);
				},
			);
		}
	}

	private async providerCall<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.PROVIDER_FAILED,
				"外部存储操作失败，请稍后重试",
			);
		}
	}

	private assertNotExpired(expiresAt: Date): void {
		if (expiresAt.getTime() <= Date.now()) {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.SESSION_EXPIRED,
				"Release 上传会话已过期，请重新创建",
			);
		}
	}

	private assertPartNumbers(
		size: number,
		partSize: number,
		partNumbers: number[],
	): void {
		const count = Math.ceil(size / partSize);
		if (partNumbers.some((part) => part > count)) {
			throw new ReleaseUploadError(
				ReleaseUploadErrorCode.SESSION_CONFLICT,
				"请求的分片编号超出会话范围",
			);
		}
	}

	private fileName(
		version: string,
		platform: "win-x64" | "linux-x64",
	): string {
		return `vcpdeck-${version}-${platform}.zip`;
	}
}
