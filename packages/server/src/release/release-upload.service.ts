import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	CONTROL_PROTOCOL_VERSION,
	RELEASE_PLATFORMS,
	ReleaseArtifactErrorCode,
	ReleaseUploadErrorCode,
	hasAllReleaseArchives,
	isReleaseArchiveAvailable,
	parseReleaseUploadComplete,
	parseReleaseUploadCreateInput,
	parseReleaseUploadPartRefresh,
	type ActorContext,
	type ReleaseInfo,
	type ReleasePlatform,
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

/** 解析会话表暂存的声明集合；数据库 TEXT 可能损坏，只接受合法的 x.y.z 版本。 */
function parseDeclared(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(item): item is string =>
					typeof item === "string" && /^\d+\.\d+\.\d+$/.test(item),
			)
			.slice(0, 3);
	} catch {
		return [];
	}
}

type RegisteredArtifact = {
	sha256: string;
	size: number;
	/** 全量构件需同时校验 Provider key；增量元数据的 key 仅用于下载定位，不参与 complete 校验（兼容存量记录）。 */
	providerKey?: string;
	checkKey: boolean;
};

/** 已登记构件中与本会话四元组对应的校验值；未登记或处于清理态时返回 null。 */
function registeredArtifact(
	archive: ServerReleaseArchiveInfo | undefined,
	artifactKind: string,
	fromVersion: string,
): RegisteredArtifact | null {
	if (
		!archive ||
		archive.availability === "deleting" ||
		archive.availability === "cleaned"
	) {
		return null;
	}
	if (artifactKind === "delta") {
		// delta 的 providerKey 只用于下载定位；complete 不校验它，以兼容缺字段的存量记录。
		const delta = archive.deltas?.find((d) => d.fromVersion === fromVersion);
		return delta
			? { sha256: delta.sha256, size: delta.size, checkKey: false }
			: null;
	}
	return {
		sha256: archive.sha256,
		size: archive.size,
		providerKey: archive.storage?.key,
		checkKey: true,
	};
}

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
	artifactKind: string;
	fromVersion: string;
	/** 该版本声明应齐备的 delta 基线集合，JSON 数组文本；仅首个 full 会话写入。 */
	expectedFromVersions: string;
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
			| {
					version_platform_artifactKind_fromVersion: {
						version: string;
						platform: string;
						artifactKind: string;
						fromVersion: string;
					};
			  };
	}): Promise<ReleaseUploadSessionRow | null>;
	findMany(args: {
		where: { version: string };
	}): Promise<ReleaseUploadSessionRow[]>;
	create(args: {
		data: {
			id: string;
			version: string;
			platform: string;
			artifactKind: string;
			fromVersion: string;
			expectedFromVersions: string;
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
		const platform = input.platform as ReleasePlatform;
		const artifactKind = input.artifactKind ?? "full";
		const fromVersion = input.fromVersion ?? "";
		// musl 只做全量：不登记增量会话，也不接受基线列表（跨 libc 无合法增量）。
		if (
			platform === "linux-x64-musl" &&
			(artifactKind === "delta" || fromVersion !== "")
		) {
			throw new ReleaseError(
				ReleaseArtifactErrorCode.ASSEMBLE_FAILED,
				"linux-x64-musl 只接受完整构件，不接受增量会话",
			);
		}

		const backend = await this.storage.getBackendConfig();
		if (backend.kind !== "alibaba") return { mode: "server" };
		const existingRelease = await this.releases.findByVersion(input.version);
		const existingArchive = existingRelease?.archives[platform];
		// 全量会话按平台整体判重；增量会话只与同平台同一基线版本判重，
		// 否则已登记的同平台 full 会把后续 delta 会话全部挡住。
		if (artifactKind === "full") {
			if (existingArchive) {
				if (
					isReleaseArchiveAvailable(existingArchive) &&
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
		} else {
			const delta = isReleaseArchiveAvailable(existingArchive)
				? existingArchive.deltas?.find((d) => d.fromVersion === fromVersion)
				: undefined;
			if (delta) {
				if (delta.sha256 === input.sha256 && delta.size === input.size) {
					return { mode: "existing", release: existingRelease as ReleaseInfo };
				}
				throw new ReleaseError(
					"RELEASE_ARCHIVE_EXISTS",
					`release ${input.version} 已存在 ${input.platform} 增量构件`,
				);
			}
		}
		const existing = await this.uploadSessions.findUnique({
			where: {
				version_platform_artifactKind_fromVersion: {
					version: input.version,
					platform: input.platform,
					artifactKind,
					fromVersion,
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

		const fileName = this.fileName(
			input.version,
			input.platform,
			artifactKind,
			fromVersion,
		);
		const provider = await this.providerCall(() =>
			this.storage.createReleaseDirectUpload(input.size, fileName),
		);
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
		const row = await this.uploadSessions.create({
			data: {
				id: randomUUID(),
				version: input.version,
				platform: input.platform,
				artifactKind,
				fromVersion,
				expectedFromVersions: JSON.stringify(input.expectedFromVersions ?? []),
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
		const platform = row.platform as ReleasePlatform;
		const registered = already?.archives[platform];
		const matched = registeredArtifact(
			registered,
			row.artifactKind,
			row.fromVersion,
		);
		if (row.status === "completed" || matched) {
			if (!already || !registered) {
				throw new ReleaseUploadError(
					ReleaseUploadErrorCode.SESSION_CONFLICT,
					"上传会话与已登记 Release 构件不一致",
				);
			}
			if (
				matched &&
				(matched.sha256 !== row.sha256 ||
					matched.size !== row.size ||
					(matched.checkKey && matched.providerKey !== row.providerKey))
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
		const release = await this.reconcileArchives(row);
		await this.markCompleted(row.id, release);
		return { release };
	}

	/**
	 * 按会话表已就绪会话整表重算 Release.archives 并写回。
	 * 不依赖 CLI 上传顺序：delta 可以早于 full 完成，声明集合只由首个 full 会话携带，
	 * 但同一版本的所有平台共享它，避免 hasAllReleaseArchives 因缺字段提前判为齐备。
	 */
	private async reconcileArchives(
		row: ReleaseUploadSessionRow,
	): Promise<ReleaseInfo> {
		const sessions = await this.uploadSessions.findMany({
			where: { version: row.version },
		});
		const ready = sessions
			.filter(
				(session) =>
					session.status === "completed" ||
					session.status === "provider_completed",
			)
			.map((session) => ({
				...session,
				artifactKind: session.artifactKind ?? "full",
				fromVersion: session.fromVersion ?? "",
			}));
		let expectedFromVersions: string[] = [];
		for (const session of ready) {
			const declared = parseDeclared(session.expectedFromVersions ?? "[]");
			if (declared.length > 0) {
				expectedFromVersions = declared;
				break;
			}
		}
		const archives: Record<string, ServerReleaseArchiveInfo> = {};
		for (const platform of RELEASE_PLATFORMS) {
			const full = ready.find(
				(session) =>
					session.platform === platform && session.artifactKind === "full",
			);
			if (!full) continue;
			const deltas = ready
				.filter(
					(session) =>
						session.platform === platform &&
						session.artifactKind === "delta" &&
						session.fromVersion !== "",
				)
				.map((session) => ({
					fromVersion: session.fromVersion,
					sha256: session.sha256,
					size: session.size,
					fileName: this.fileName(
						row.version,
						platform,
						"delta",
						session.fromVersion,
					),
					// delta 的对象 key 必须落库，否则 /file?fromVersion= 拿不到增量包。
					providerKey: session.providerKey,
				}));
			archives[platform] = {
				sha256: full.sha256,
				size: full.size,
				fileName: this.fileName(row.version, platform, "full", ""),
				availability: "available",
				storage: {
					provider: full.provider,
					key: full.providerKey,
					mode: "direct",
				},
				deltas,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				expectedFromVersions,
			};
		}
		const current = await this.releases.findByVersionWithStorage(row.version);
		if (current) {
			return this.releases.replaceArchives(row.version, archives);
		}
		return this.releases.create({
			version: row.version,
			archives,
			createdByName: row.createdByName ?? undefined,
			createdVia: row.createdVia ?? undefined,
		});
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
		if (hasAllReleaseArchives(release)) {
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
		platform: ReleasePlatform,
		artifactKind: string,
		fromVersion: string,
	): string {
		return artifactKind === "delta"
			? `vcpdeck-${version}-${platform}-delta-${fromVersion}.zip`
			: `vcpdeck-${version}-${platform}.zip`;
	}
}
