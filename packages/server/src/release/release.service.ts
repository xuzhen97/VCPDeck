/**
 * Release 领域服务：上传记录、状态流转、客户端状态维护、sha256 校验。
 * 详见 docs/design/release-and-update.md。
 */
import { Injectable, Inject } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	ReleaseStatus,
	type PaginatedResult,
	type ReleaseClientEntry,
	type ReleaseClientState,
	type ReleaseInfo,
	type ReleasePlatform,
	isReleaseArchiveAvailable,
	type ReleaseArchiveAvailableInfo,
	type ReleaseArchiveDeletingInfo,
	type ReleaseArchiveInfo,
	type ReleaseArchiveStorage,
	type ReleaseArchiveStorageSummary,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";

/** release 领域错误：code 稳定，message 安全（不含文件内容/密钥） */
export class ReleaseError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ReleaseError";
	}
}

/** Release 状态机允许的流转。 */
const ALLOWED_TRANSITIONS: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
	[ReleaseStatus.UPLOADED]: [ReleaseStatus.UPDATING_SERVER, ReleaseStatus.FAILED],
	[ReleaseStatus.UPDATING_SERVER]: [
		ReleaseStatus.UPDATING_CLIENTS,
		ReleaseStatus.FAILED,
	],
	[ReleaseStatus.UPDATING_CLIENTS]: [ReleaseStatus.DONE, ReleaseStatus.FAILED],
	[ReleaseStatus.DONE]: [],
	[ReleaseStatus.FAILED]: [],
};

export type ReleaseArchiveStorageRecord = ReleaseArchiveStorage & {
	/** Server 内部 Provider 对象 key；不得进入 API 响应。 */
	key: string;
};

export type ServerReleaseArchiveInfo =
	| (Omit<ReleaseArchiveAvailableInfo, "storage"> & {
			storage?: ReleaseArchiveStorageRecord;
	  })
	| (Omit<ReleaseArchiveDeletingInfo, "storage"> & {
			storage?: ReleaseArchiveStorageRecord;
	  })
	| Extract<ReleaseArchiveInfo, { availability: "cleaned" }>;

export type ServerReleaseInfo = Omit<ReleaseInfo, "archives"> & {
	archives: Partial<Record<ReleasePlatform, ServerReleaseArchiveInfo>>;
};

export interface CreateReleaseInput {
	version: string;
	/** 平台 -> 构件信息（首次上传至少含一个平台，另一个平台经 addArchive 补充） */
	archives: Record<string, ServerReleaseArchiveInfo>;
	/** 上传者（由 AuthGuard 注入） */
	createdByName?: string;
	createdVia?: string;
}

/** 单条客户端状态：兼容旧格式（裸枚举字符串）与新格式（{ state, reason?, at }） */
function normalizeEntry(
	value: unknown,
	fallbackAt: string,
): ReleaseClientEntry | null {
	if (typeof value === "string") {
		// 旧格式：裸状态枚举值（历史数据兼容）
		return { state: value as ReleaseClientState, at: fallbackAt };
	}
	if (typeof value === "object" && value !== null) {
		const entry = value as Partial<ReleaseClientEntry>;
		if (typeof entry.state === "string") {
			return {
				state: entry.state,
				...(typeof entry.reason === "string" && entry.reason
					? { reason: entry.reason }
					: {}),
				at: typeof entry.at === "string" ? entry.at : fallbackAt,
			};
		}
	}
	return null;
}

interface ReleaseDbRow {
	version: string;
	archives: string;
	status: string;
	errorMessage: string | null;
	createdByName: string | null;
	createdVia: string | null;
	clientStates: string;
	createdAt: Date;
	updatedAt: Date;
}

function parseStorage(value: unknown): ReleaseArchiveStorageRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const storage = value as Partial<ReleaseArchiveStorageRecord>;
	if (
		typeof storage.provider !== "string" ||
		!storage.provider ||
		typeof storage.key !== "string" ||
		!storage.key ||
		storage.mode !== "direct"
	) {
		return undefined;
	}
	return {
		provider: storage.provider,
		key: storage.key,
		mode: "direct",
	};
}

function parseArchive(value: unknown): ServerReleaseArchiveInfo | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const entry = value as Record<string, unknown>;
	if (
		typeof entry.sha256 !== "string" ||
		typeof entry.fileName !== "string" ||
		typeof entry.size !== "number"
	) {
		return null;
	}
	const base = {
		sha256: entry.sha256,
		size: entry.size,
		fileName: entry.fileName,
	};
	if (entry.availability === "cleaned") {
		if (
			typeof entry.cleanedAt !== "string" ||
			Number.isNaN(Date.parse(entry.cleanedAt)) ||
			entry.cleanupReason !== "retention_policy"
		) {
			return null;
		}
		const summary = entry.storageSummary;
		let storageSummary: ReleaseArchiveStorageSummary | undefined;
		if (summary !== undefined) {
			if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
				return null;
			}
			const parsedSummary = summary as Partial<ReleaseArchiveStorageSummary>;
			if (
				typeof parsedSummary.provider !== "string" ||
				!parsedSummary.provider ||
				parsedSummary.mode !== "direct"
			) {
				return null;
			}
			storageSummary = {
				provider: parsedSummary.provider,
				mode: "direct",
			};
		}
		return {
			...base,
			availability: "cleaned",
			...(storageSummary ? { storageSummary } : {}),
			cleanedAt: entry.cleanedAt,
			cleanupReason: "retention_policy",
		};
	}
	if (
		entry.availability !== undefined &&
		entry.availability !== "available" &&
		entry.availability !== "deleting"
	) {
		return null;
	}
	const storage =
		entry.storage === undefined ? undefined : parseStorage(entry.storage);
	if (entry.storage !== undefined && !storage) return null;
	return {
		...base,
		availability: entry.availability ?? "available",
		...(storage ? { storage } : {}),
	};
}

function parseArchives(raw: string): Partial<Record<ReleasePlatform, ServerReleaseArchiveInfo>> {
	const archives: Partial<Record<ReleasePlatform, ServerReleaseArchiveInfo>> = {};
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		for (const [platform, value] of Object.entries(parsed)) {
			if (platform !== "win-x64" && platform !== "linux-x64") continue;
			const archive = parseArchive(value);
			if (archive) archives[platform] = archive;
		}
	} catch {
		return {};
	}
	return archives;
}

/** 去除 Server 内部 Provider key，生成可安全返回 API 的 archive。 */
function toPublicArchive(archive: ServerReleaseArchiveInfo): ReleaseArchiveInfo {
	if (archive.storage) {
		const { key: _key, ...storage } = archive.storage;
		return { ...archive, storage } as ReleaseArchiveInfo;
	}
	return archive;
}

/** 将 Server 内部 Release 投影为不含 Provider key 的公开对象。 */
export function toPublicReleaseInfo(info: ServerReleaseInfo): ReleaseInfo {
	return {
		...info,
		archives: Object.fromEntries(
			Object.entries(info.archives).map(([platform, archive]) => [
				platform,
				toPublicArchive(archive as ServerReleaseArchiveInfo),
			]),
		) as ReleaseInfo["archives"],
	};
}

/** DB 行 → API 形态（archives/clientStates 解析为对象，日期转 ISO 字符串）。 */
export function toReleaseInfo(row: ReleaseDbRow): ReleaseInfo {
	const fallbackAt = row.updatedAt.toISOString();
	let clientStates: Record<string, ReleaseClientEntry> = {};
	try {
		const parsed = JSON.parse(row.clientStates) as Record<string, unknown>;
		for (const [clientId, value] of Object.entries(parsed)) {
			const entry = normalizeEntry(value, fallbackAt);
			if (entry) clientStates[clientId] = entry;
		}
	} catch {
		clientStates = {};
	}
	const archives = parseArchives(row.archives);
	return toPublicReleaseInfo({
		version: row.version,
		archives,
		status: row.status as ReleaseStatus,
		errorMessage: row.errorMessage,
		createdByName: row.createdByName,
		createdVia: row.createdVia,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		clientStates,
	});
}

@Injectable()
export class ReleaseService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/** 上传后登记 release（版本重复抛 RELEASE_DUPLICATE_VERSION） */
	async create(input: CreateReleaseInput): Promise<ReleaseInfo> {
		const existing = await this.prisma.release.findUnique({
			where: { version: input.version },
		});
		if (existing) {
			throw new ReleaseError(
				"RELEASE_DUPLICATE_VERSION",
				`版本 ${input.version} 已存在`,
			);
		}
		const row = await this.prisma.release.create({
			data: {
				id: randomUUID(),
				version: input.version,
				archives: JSON.stringify(
					Object.fromEntries(
						Object.entries(input.archives).map(([platform, archive]) => [
							platform,
							{ ...archive, availability: archive.availability ?? "available" },
						]),
					),
				),
				status: "uploaded",
				clientStates: "{}",
				createdByName: input.createdByName ?? null,
				createdVia: input.createdVia ?? null,
			},
		});
		return toReleaseInfo(row);
	}

	/**
	 * 补充单个平台的构件（第二次上传）。已存在同平台构件或 release 不存在时抛错。
	 * 返回更新后的 release。
	 */
	async addArchive(
		version: string,
		platform: ReleasePlatform,
		archive: ServerReleaseArchiveInfo,
	): Promise<ReleaseInfo> {
		const row = await this.prisma.release.findUnique({ where: { version } });
		if (!row) {
			throw new ReleaseError("RELEASE_NOT_FOUND", `release ${version} 不存在`);
		}
		const archives = parseArchives(row.archives);
		if (archives[platform]) {
			throw new ReleaseError(
				"RELEASE_ARCHIVE_EXISTS",
				`release ${version} 已存在 ${platform} 构件`,
			);
		}
		const updatedArchives = {
			...archives,
			[platform]: { ...archive, availability: archive.availability ?? "available" },
		};
		const updated = await this.prisma.release.update({
			where: { version },
			data: { archives: JSON.stringify(updatedArchives) },
		});
		return toReleaseInfo(updated);
	}

	/** release 是否已包含全部支持平台的构件（补齐后才允许触发更新） */
	hasAllArchives(release: ReleaseInfo): boolean {
		return (
			isReleaseArchiveAvailable(release.archives["win-x64"]) &&
			isReleaseArchiveAvailable(release.archives["linux-x64"])
		);
	}

	/** 分页列表（遵循 AGENTS.md 分页规范） */
	async list(page = 1, pageSize = 20): Promise<PaginatedResult<ReleaseInfo>> {
		const [rows, total] = await Promise.all([
			this.prisma.release.findMany({
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.prisma.release.count(),
		]);
		return {
			data: rows.map(toReleaseInfo),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	async findByVersion(version: string): Promise<ReleaseInfo | null> {
		const row = await this.prisma.release.findUnique({ where: { version } });
		return row ? toReleaseInfo(row) : null;
	}

	/** Server 内部读取 Release；仅供下载/清理/直传登记使用，不可直接返回 API。 */
	async findByVersionWithStorage(
		version: string,
	): Promise<ServerReleaseInfo | null> {
		const row = await this.prisma.release.findUnique({ where: { version } });
		if (!row) return null;
		const publicInfo = toReleaseInfo(row);
		return {
			...publicInfo,
			archives: parseArchives(row.archives),
		};
	}

	/** 返回清理策略使用的全部公开 Release；具体删除时再通过 CAS 读取内部 key。 */
	async listForCleanup(): Promise<ReleaseInfo[]> {
		const rows = await this.prisma.release.findMany({
			orderBy: { createdAt: "desc" },
		});
		return rows.map(toReleaseInfo);
	}

	/** 以 archive JSON 做条件更新，声明一个 archive 进入 deleting。 */
	async claimArchiveForCleanup(
		version: string,
		platform: ReleasePlatform,
	): Promise<{
		sha256: string;
		size: number;
		fileName: string;
		availability: "deleting";
		storage?: ReleaseArchiveStorageRecord;
	} | null> {
		const row = await this.prisma.release.findUnique({ where: { version } });
		if (!row) return null;
		const archives = parseArchives(row.archives);
		const archive = archives[platform];
		if (
			!archive ||
			archive.availability === "deleting" ||
			archive.availability === "cleaned"
		) {
			return null;
		}
		const deleting = {
			sha256: archive.sha256,
			size: archive.size,
			fileName: archive.fileName,
			availability: "deleting" as const,
			...(archive.storage ? { storage: archive.storage } : {}),
		};
		const updatedArchives = { ...archives, [platform]: deleting };
		const result = await this.prisma.release.updateMany({
			where: { version, archives: row.archives },
			data: { archives: JSON.stringify(updatedArchives) },
		});
		return result.count === 1 ? deleting : null;
	}

	/** 以 archive JSON 做条件更新，完成正文删除并保留审计摘要。 */
	async finishArchiveCleanup(
		version: string,
		platform: ReleasePlatform,
		cleanedAt: string,
	): Promise<boolean> {
		if (Number.isNaN(Date.parse(cleanedAt))) return false;
		const row = await this.prisma.release.findUnique({ where: { version } });
		if (!row) return false;
		const archives = parseArchives(row.archives);
		const archive = archives[platform];
		if (!archive || archive.availability !== "deleting") return false;
		const cleaned = {
			sha256: archive.sha256,
			size: archive.size,
			fileName: archive.fileName,
			availability: "cleaned" as const,
			...(archive.storage
				? {
						storageSummary: {
							provider: archive.storage.provider,
							mode: archive.storage.mode,
						},
					}
				: {}),
			cleanedAt,
			cleanupReason: "retention_policy" as const,
		};
		const result = await this.prisma.release.updateMany({
			where: { version, archives: row.archives },
			data: { archives: JSON.stringify({ ...archives, [platform]: cleaned }) },
		});
		return result.count === 1;
	}

	/** 清理失败时将当前 archive 恢复为可重试的 available。 */
	async restoreArchiveAfterCleanup(
		version: string,
		platform: ReleasePlatform,
	): Promise<boolean> {
		const row = await this.prisma.release.findUnique({ where: { version } });
		if (!row) return false;
		const archives = parseArchives(row.archives);
		const archive = archives[platform];
		if (!archive || archive.availability !== "deleting") return false;
		const available = { ...archive, availability: "available" as const };
		const result = await this.prisma.release.updateMany({
			where: { version, archives: row.archives },
			data: { archives: JSON.stringify({ ...archives, [platform]: available }) },
		});
		return result.count === 1;
	}

	/**
	 * 状态流转（原子）：先校验当前状态允许流转，再按 version+status 条件更新，
	 * 条件更新条数为 0 视为并发修改/非法流转。
	 */
	async transitionStatus(
		version: string,
		to: ReleaseStatus,
		errorMessage?: string,
	): Promise<void> {
		const current = await this.prisma.release.findUnique({
			where: { version },
		});
		if (!current) {
			throw new ReleaseError("RELEASE_NOT_FOUND", `release ${version} 不存在`);
		}
		const allowed = ALLOWED_TRANSITIONS[current.status as ReleaseStatus] ?? [];
		if (!allowed.includes(to)) {
			throw new ReleaseError(
				"RELEASE_INVALID_TRANSITION",
				`不允许从 ${current.status} 流转到 ${to}`,
			);
		}
		const result = await this.prisma.release.updateMany({
			where: { version, status: current.status },
			data: { status: to, errorMessage: errorMessage ?? null },
		});
		if (result.count === 0) {
			throw new ReleaseError(
				"RELEASE_INVALID_TRANSITION",
				`状态已被并发修改，无法流转到 ${to}`,
			);
		}
	}

	/**
	 * 记录单个客户端在 release 中的更新状态（含失败原因与时间戳，审计用）。
	 * 返回合并后的完整状态表。
	 */
	async markClientState(
		version: string,
		clientId: string,
		state: ReleaseClientState,
		reason?: string,
	): Promise<Record<string, ReleaseClientEntry>> {
		const row = await this.prisma.release.findUnique({ where: { version } });
		if (!row) {
			throw new ReleaseError("RELEASE_NOT_FOUND", `release ${version} 不存在`);
		}
		const fallbackAt = row.updatedAt.toISOString();
		let states: Record<string, ReleaseClientEntry> = {};
		try {
			const parsed = JSON.parse(row.clientStates) as Record<string, unknown>;
			for (const [id, value] of Object.entries(parsed)) {
				const entry = normalizeEntry(value, fallbackAt);
				if (entry) states[id] = entry;
			}
		} catch {
			states = {};
		}
		states[clientId] = {
			state,
			...(reason ? { reason } : {}),
			at: new Date().toISOString(),
		};
		await this.prisma.release.update({
			where: { version },
			data: { clientStates: JSON.stringify(states) },
		});
		return states;
	}

	/** 置为 failed（附安全错误摘要） */
	async markFailed(version: string, errorMessage: string): Promise<void> {
		await this.transitionStatus(version, ReleaseStatus.FAILED, errorMessage);
	}

	/** 当前活动目标版本：最近一条具有双平台可用构件的 updating_clients/done release。 */
	async getLatestActiveTarget(): Promise<ReleaseInfo | null> {
		const rows = await this.prisma.release.findMany({
			where: {
				status: { in: [ReleaseStatus.UPDATING_CLIENTS, ReleaseStatus.DONE] },
			},
			orderBy: { createdAt: "desc" },
		});
		for (const row of rows) {
			const release = toReleaseInfo(row);
			if (this.hasAllArchives(release)) return release;
		}
		return null;
	}

	/** 进行中的 release：updating_server / updating_clients（编排器忙检查与启动恢复用） */
	async getActiveRelease(): Promise<ReleaseInfo | null> {
		const row = await this.prisma.release.findFirst({
			where: {
				status: {
					in: [ReleaseStatus.UPDATING_SERVER, ReleaseStatus.UPDATING_CLIENTS],
				},
			},
			orderBy: { createdAt: "desc" },
		});
		return row ? toReleaseInfo(row) : null;
	}

	/** 流式计算文件 sha256 并与期望值比对（文件不存在/读失败返回 false） */
	async verifyZipSha256(filePath: string, expected: string): Promise<boolean> {
		return new Promise((resolve) => {
			const hash = createHash("sha256");
			const stream = createReadStream(filePath);
			stream.on("error", () => resolve(false));
			stream.on("data", (chunk) => hash.update(chunk));
			stream.on("end", () => resolve(hash.digest("hex") === expected));
		});
	}
}
