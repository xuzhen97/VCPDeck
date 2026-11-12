// ── 自更新协议（server ↔ client 经 WebSocket，launcher 经本地控制通道） ──
// 详见 docs/design/release-and-update.md

/** 控制协议版本；破坏性协议变更时递增，Launcher 与 Server 双向校验。 */
export const CONTROL_PROTOCOL_VERSION = 2;

/** 发布构件种类：full 为旧格式整包，delta 为内容寻址增量包。 */
export type ReleaseArtifactKind = "full" | "delta";

/** 目标版本完整清单中的单个文件条目。 */
export interface ReleaseFileEntry {
	/** 相对 apps/<version>/ 的 POSIX 路径，禁止 ..、绝对路径与盘符 */
	path: string;
	/** 文件字节 sha256（64 位小写十六进制） */
	sha256: string;
	/** 文件字节数（非负安全整数） */
	size: number;
	/** POSIX 权限位 */
	mode: number;
}

/** 平台归档记录内的增量构件信息。 */
export interface ReleaseArchiveDelta {
	fromVersion: string;
	sha256: string;
	size: number;
	fileName: string;
}

/** delta 包内的清单（由发布者签名，Launcher 解压前校验）。 */
export interface ReleaseDeltaManifest {
	version: string;
	protocolVersion: 2;
	kind: "delta";
	fromVersion: string;
	files: ReleaseFileEntry[];
}

/** Server 下发给 Launcher 的候选增量包信息。 */
export interface ReleaseDeltaCandidate {
	fromVersion: string;
	url: string;
	sha256: string;
	size: number;
}

/** Launcher 后台 prepare 状态。 */
export type LauncherPrepareState = "idle" | "preparing" | "ready" | "failed";

/** Launcher 后台 prepare 状态快照（经本地控制通道回报）。 */
export interface LauncherPrepareStatus {
	state: LauncherPrepareState;
	version: string | null;
	errorCode?: string;
}

/** 内容寻址发布构件稳定错误码（ADR-0062）。 */
export const ReleaseArtifactErrorCode = {
	LAUNCHER_UPGRADE_REQUIRED: "LAUNCHER_UPGRADE_REQUIRED",
	MANIFEST_SIGNATURE_INVALID: "MANIFEST_SIGNATURE_INVALID",
	MANIFEST_PATH_UNSAFE: "MANIFEST_PATH_UNSAFE",
	FILE_HASH_MISMATCH: "FILE_HASH_MISMATCH",
	DELTA_BASELINE_UNAVAILABLE: "DELTA_BASELINE_UNAVAILABLE",
	ASSEMBLE_FAILED: "ASSEMBLE_FAILED",
	RELEASE_ARTIFACTS_INCOMPLETE: "RELEASE_ARTIFACTS_INCOMPLETE",
} as const;

/** 更新包 manifest（打包时生成，随 archive 携带） */
export interface UpdateManifest {
	version: string;
	/** 所需 Node 版本约束（如 ">=24"），launcher ensure-node 使用 */
	nodeVersion: string;
	/** launcher 最低兼容版本（由 `/update` 计划端点校验；`/file` 下载路径不校验） */
	launcherMinVersion: string;
	/** 随发布包提供的稳定 Launcher 入口；首次安装时复制到 app-dir 外部路径 */
	launcher?: {
		dir: string;
		entry: string;
	};
	/** archive 整体 sha256（当前 manifest 内留空，权威值存于 Release 并随更新请求下发） */
	sha256: string;
	artifacts: {
		server?: {
			dir: string;
			entry: string;
			/** 启动前钩子，如 "prisma db push" */
			preStart?: string;
		};
		client?: {
			dir: string;
			entry: string;
		};
	};
	/** 清单协议版本（内容寻址方案起为 2；旧 full 包缺省视为 1） */
	protocolVersion?: number;
	/** 构件种类；旧 full 包缺省 */
	kind?: ReleaseArtifactKind;
	/** 目标版本完整文件清单；签名与验签共用同一对象 */
	files?: ReleaseFileEntry[];
}

/** 服务端 → 客户端：请求更新（含下载地址与校验值） */
export interface UpdateRequest {
	releaseVersion: string;
	/** 更新包下载 URL（客户端 launcher 使用） */
	url: string;
	sha256: string;
	/** 优雅停机等待上限（ms），缺省 10 分钟 */
	timeoutMs?: number;
	/** 候选增量包；Server 不判断 Client 版本，由 Launcher 自行挑选基线 */
	candidates?: ReleaseDeltaCandidate[];
}

/** 客户端 → 服务端：优雅停机完成，launcher 即将接管 */
export interface UpdateReady {
	clientId: string;
	releaseVersion: string;
}

/** 客户端 → 服务端：更新失败（原因仅安全摘要，不含文件内容） */
export interface UpdateFailed {
	clientId: string;
	releaseVersion: string;
	reason: string;
}

/** 服务端 → 广播：服务端即将重启（客户端保持运行，稍后自动重连） */
export interface ServerShutdownNotice {
	expectedVersion?: string;
	reconnectDelayMs?: number;
}

/** Release 状态机：uploaded → updating_server → updating_clients → done/failed */
export enum ReleaseStatus {
	UPLOADED = "uploaded",
	UPDATING_SERVER = "updating_server",
	UPDATING_CLIENTS = "updating_clients",
	DONE = "done",
	FAILED = "failed",
}

/** 单客户端在某个 release 中的更新状态 */
export enum ReleaseClientState {
	PENDING = "pending",
	UPDATING = "updating",
	DONE = "done",
	FAILED = "failed",
}

/** 客户端更新失败类别：瞬时失败值得重试，永久失败重试无用。 */
export type ReleaseFailureKind = "transient" | "permanent";

/** 单客户端更新条目（含失败原因与时间戳，审计用） */
export interface ReleaseClientEntry {
	state: ReleaseClientState;
	/** 失败原因摘要（仅 failed 时非空，安全脱敏） */
	reason?: string;
	/** 最后状态变更时间（ISO 字符串） */
	at: string;
	/** 失败类别；缺省视为 transient，使存量记录天然可重试 */
	kind?: ReleaseFailureKind;
	/** 已尝试次数；用于退避与上限判定 */
	attempts?: number;
}

/** 发布包支持的目标平台（打包脚本产出对应的分发 zip） */
export type ReleasePlatform = "win-x64" | "linux-x64";

/** Release 上传会话稳定错误码。 */
export const ReleaseUploadErrorCode = {
	DIRECT_UPLOAD_REQUIRED: "RELEASE_DIRECT_UPLOAD_REQUIRED",
	SESSION_NOT_FOUND: "RELEASE_UPLOAD_SESSION_NOT_FOUND",
	SESSION_EXPIRED: "RELEASE_UPLOAD_SESSION_EXPIRED",
	SESSION_CONFLICT: "RELEASE_UPLOAD_SESSION_CONFLICT",
	SIZE_MISMATCH: "RELEASE_UPLOAD_SIZE_MISMATCH",
	PROVIDER_FAILED: "RELEASE_UPLOAD_PROVIDER_FAILED",
} as const;

/** Release 人工重试稳定错误码。 */
export const ReleaseRetryErrorCode = {
	NOT_FOUND: "RELEASE_NOT_FOUND",
	CLIENT_NOT_FOUND: "RELEASE_CLIENT_NOT_FOUND",
	RETRY_NOT_ALLOWED: "RELEASE_RETRY_NOT_ALLOWED",
} as const;

/** 创建 Release 上传会话的严格输入。 */
export interface ReleaseUploadCreateInput {
	version: string;
	platform: ReleasePlatform;
	sha256: string;
	size: number;
	/** 构件种类；缺省按存量 full 会话处理 */
	artifactKind?: ReleaseArtifactKind;
	/** delta 包的基线版本；full 包为空串 */
	fromVersion?: string;
	/** 该版本声明应齐备的 delta 基线集合；仅首个 full 会话携带 */
	expectedFromVersions?: string[];
}

/** 外部 Provider 的单个直传分片。 */
export interface ReleaseUploadPart {
	partNumber: number;
	url: string;
}

/** Release 上传会话协商结果。 */
export type ReleaseUploadSession =
	| { mode: "server" }
	| { mode: "existing"; release: ReleaseInfo }
	| {
			mode: "direct";
			sessionId: string;
			partSize: number;
			parts: ReleaseUploadPart[];
			expiresAt: string;
	  };

/** 严格解析 Release 上传会话创建输入。 */
export function parseReleaseUploadCreateInput(
	value: unknown,
): ReleaseUploadCreateInput {
	const shapeError =
		"body 必须且只能包含 version/platform/sha256/size（可附 artifactKind/fromVersion/expectedFromVersions）";
	const requiredKeys: readonly string[] = [
		"version",
		"platform",
		"sha256",
		"size",
	];
	const allowedKeys: readonly string[] = [
		...requiredKeys,
		"artifactKind",
		"fromVersion",
		"expectedFromVersions",
	];
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
		requiredKeys.some((key) => !Object.keys(value).includes(key))
	) {
		throw new Error(shapeError);
	}
	if (
		typeof value.version !== "string" ||
		!/^\d+\.\d+\.\d+$/.test(value.version)
	) {
		throw new Error("version 格式应为 x.y.z");
	}
	if (value.platform !== "win-x64" && value.platform !== "linux-x64") {
		throw new Error("platform 应为 win-x64 或 linux-x64");
	}
	if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
		throw new Error("sha256 应为 64 位小写十六进制");
	}
	if (
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size < 1 ||
		value.size > 2_147_483_647
	) {
		throw new Error("size 应为 1–2147483647 的整数");
	}
	const result: ReleaseUploadCreateInput = {
		version: value.version,
		platform: value.platform,
		sha256: value.sha256,
		size: value.size,
	};
	if (value.artifactKind !== undefined) {
		const kind = value.artifactKind;
		if (typeof kind !== "string" || (kind !== "full" && kind !== "delta")) {
			throw new Error("artifactKind 应为 full 或 delta");
		}
		result.artifactKind = kind;
	}
	if (value.fromVersion !== undefined) {
		const fromVersion = value.fromVersion;
		if (
			typeof fromVersion !== "string" ||
			(fromVersion !== "" && !/^\d+\.\d+\.\d+$/.test(fromVersion))
		) {
			throw new Error("fromVersion 应为空串或 x.y.z 格式");
		}
		result.fromVersion = fromVersion;
	}
	if (value.expectedFromVersions !== undefined) {
		const list = value.expectedFromVersions;
		if (
			!Array.isArray(list) ||
			list.length > 3 ||
			list.some(
				(item) => typeof item !== "string" || !/^\d+\.\d+\.\d+$/.test(item),
			) ||
			new Set(list).size !== list.length
		) {
			throw new Error("expectedFromVersions 应为至多 3 个不重复的 x.y.z 版本");
		}
		result.expectedFromVersions = list as string[];
	}
	return result;
}

/** 严格解析需要刷新的分片编号。 */
export function parseReleaseUploadPartRefresh(value: unknown): {
	partNumbers: number[];
} {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["partNumbers"]) ||
		!Array.isArray(value.partNumbers)
	) {
		throw new Error("body 必须且只能包含 partNumbers 数组");
	}
	const partNumbers = value.partNumbers;
	if (
		partNumbers.length < 1 ||
		partNumbers.length > 100 ||
		partNumbers.some(
			(part) => !Number.isInteger(part) || part < 1 || part > 10_000,
		) ||
		new Set(partNumbers).size !== partNumbers.length
	) {
		throw new Error("partNumbers 必须包含 1–100 个不重复的 1–10000 整数");
	}
	return { partNumbers: partNumbers as number[] };
}

/** 严格解析 Release 直传完成输入。 */
export function parseReleaseUploadComplete(value: unknown): {
	uploadedBytes: number;
} {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["uploadedBytes"]) ||
		typeof value.uploadedBytes !== "number" ||
		!Number.isSafeInteger(value.uploadedBytes) ||
		value.uploadedBytes < 1 ||
		value.uploadedBytes > 2_147_483_647
	) {
		throw new Error("body 必须且只能包含有效整数 uploadedBytes");
	}
	return { uploadedBytes: value.uploadedBytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value);
	return (
		actual.length === keys.length && actual.every((key) => keys.includes(key))
	);
}

/** 清单签名规范化的固定键序（ADR-0062:24）；签名与验签必须共用。 */
const RELEASE_MANIFEST_KEY_ORDER = [
	"version",
	"protocolVersion",
	"kind",
	"fromVersion",
	"files",
	"nodeVersion",
	"launcherMinVersion",
	"launcher",
	"sha256",
	"artifacts",
] as const;

/** 判断清单文件路径是否为相对 apps/<version>/ 的安全 POSIX 路径。 */
export function isSafeReleaseFilePath(path: string): boolean {
	if (typeof path !== "string" || path.length === 0) return false;
	if (path.includes("\0") || path.includes("\\")) return false;
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
	return path
		.split("/")
		.every(
			(segment) =>
				segment.length > 0 && segment !== "." && segment !== "..",
		);
}

/** 按固定键序生成清单规范化字节；与对象自身键序无关。 */
export function canonicalReleaseManifestJson(
	manifest: Record<string, unknown>,
): string {
	const ordered: Record<string, unknown> = {};
	for (const key of RELEASE_MANIFEST_KEY_ORDER) {
		if (Object.prototype.hasOwnProperty.call(manifest, key)) {
			ordered[key] = manifest[key];
		}
	}
	return JSON.stringify(ordered);
}

/** 严格解析清单文件条目，拒绝未知字段与不安全路径。 */
export function parseReleaseFileEntry(value: unknown): ReleaseFileEntry {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["path", "sha256", "size", "mode"])
	) {
		throw new Error("文件条目必须且只能包含 path/sha256/size/mode");
	}
	if (typeof value.path !== "string" || !isSafeReleaseFilePath(value.path)) {
		throw new Error("path 应为相对 apps/<version>/ 的安全 POSIX 路径");
	}
	if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
		throw new Error("sha256 应为 64 位小写十六进制");
	}
	if (
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size < 0
	) {
		throw new Error("size 应为非负安全整数");
	}
	if (
		typeof value.mode !== "number" ||
		!Number.isInteger(value.mode) ||
		value.mode < 0 ||
		value.mode > 0o7777
	) {
		throw new Error("mode 应为合法 POSIX 权限位");
	}
	return {
		path: value.path,
		sha256: value.sha256,
		size: value.size,
		mode: value.mode,
	};
}

/** 严格解析 delta 包清单；键集合与协议版本均固定。 */
export function parseReleaseDeltaManifest(value: unknown): ReleaseDeltaManifest {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"version",
			"protocolVersion",
			"kind",
			"fromVersion",
			"files",
		])
	) {
		throw new Error(
			"delta 清单必须且只能包含 version/protocolVersion/kind/fromVersion/files",
		);
	}
	if (
		typeof value.version !== "string" ||
		!/^\d+\.\d+\.\d+$/.test(value.version)
	) {
		throw new Error("version 格式应为 x.y.z");
	}
	if (value.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
		throw new Error("protocolVersion 应为 2");
	}
	if (value.kind !== "delta") {
		throw new Error("kind 应为 delta");
	}
	if (
		typeof value.fromVersion !== "string" ||
		!/^\d+\.\d+\.\d+$/.test(value.fromVersion)
	) {
		throw new Error("fromVersion 格式应为 x.y.z");
	}
	if (!Array.isArray(value.files)) {
		throw new Error("files 应为数组");
	}
	return {
		version: value.version,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		kind: "delta",
		fromVersion: value.fromVersion,
		files: value.files.map(parseReleaseFileEntry),
	};
}

/** 可用发布构件（旧记录允许缺失 availability）。 */
export type ReleaseArchiveAvailableInfo = ReleaseArchiveBase & {
	/** 旧 Release JSON 缺失该字段时按 available 兼容解析。 */
	availability?: "available";
	/** 外部存储直连信息（ADR-0019；Local 后端无此字段） */
	storage?: ReleaseArchiveStorage;
	/** 该平台已上传的增量构件；旧记录缺省 */
	deltas?: ReleaseArchiveDelta[];
	/** 清单协议版本；旧记录缺省按 1 处理 */
	protocolVersion?: number;
	/** 该版本声明应齐备的 delta 基线版本集合；缺省按空集兼容存量 Release */
	expectedFromVersions?: string[];
};

/** 正在清理的发布构件。 */
export type ReleaseArchiveDeletingInfo = ReleaseArchiveBase & {
	availability: "deleting";
	/** 对外仅保留后端摘要；Server 内部记录另行保留定位信息用于重启恢复。 */
	storage?: ReleaseArchiveStorage;
};

/** 单个平台的发布构件信息（校验值、体积与生命周期）。 */
export type ReleaseArchiveInfo =
	| ReleaseArchiveAvailableInfo
	| ReleaseArchiveDeletingInfo
	| (ReleaseArchiveBase & {
			availability: "cleaned";
			/** 清理态禁止保留实际对象定位信息。 */
			storage?: never;
			/** 清理后保留的非敏感存储摘要，不包含对象 key。 */
			storageSummary?: ReleaseArchiveStorageSummary;
			cleanedAt: string;
			cleanupReason: ReleaseCleanupReason;
		  });

interface ReleaseArchiveBase {
	sha256: string;
	size: number;
	fileName: string;
}

/** 发布构件存储信息（ADR-0019：外部存储上传/下载双向直连）。
 * Local 后端无此字段；目标机经统一入口 302 直连存储下载。 */
export interface ReleaseArchiveStorage {
	/** 存储后端 kind（local / alibaba 等）；不包含 Provider 对象 key */
	provider: string;
	/** 分发模式：direct = 目标机经统一入口 302 直连存储 */
	mode: "direct";
}

/** 清理后保留的发布构件存储摘要。 */
export interface ReleaseArchiveStorageSummary {
	/** 原存储后端 kind */
	provider: string;
	/** 原分发模式 */
	mode: "direct";
}

/** 发布构件生命周期状态。 */
export type ReleaseArchiveAvailability = "available" | "deleting" | "cleaned";

/** 发布构件清理原因。 */
export type ReleaseCleanupReason = "retention_policy";

/** 只有正文仍可用的构件才可参与下载、编排、安装和补更。 */
export function isReleaseArchiveAvailable(
	archive: ReleaseArchiveInfo | undefined,
): archive is ReleaseArchiveAvailableInfo {
	return Boolean(
		archive &&
		(archive.availability === undefined || archive.availability === "available"),
	);
}

/**
 * release 是否已包含全部支持平台的可用构件。
 * 这是「是否可以开始编排」的判据，**不含状态条件**：上传刚完成时状态仍是 uploaded。
 */
export function hasAllReleaseArchives(release: ReleaseInfo): boolean {
	const archives = release.archives ?? {};
	const platforms: readonly ReleasePlatform[] = ["win-x64", "linux-x64"];
	return platforms.every((platform) => {
		const archive = archives[platform];
		if (!isReleaseArchiveAvailable(archive)) return false;
		const deltas = archive.deltas ?? [];
		const present = new Set(deltas.map((delta) => delta.fromVersion));
		const expected = archive.expectedFromVersions ?? [];
		return expected.every((fromVersion) => present.has(fromVersion));
	});
}

/**
 * release 是否可作为补更目标：双平台构件均可用，且已进入客户端更新阶段或已完成。
 * 这是 Server 与 CLI 共用的唯一判定，避免两端各自复制规则产生偏差。
 */
export function isCatchUpTarget(release: ReleaseInfo): boolean {
	if (
		release.status !== ReleaseStatus.UPDATING_CLIENTS &&
		release.status !== ReleaseStatus.DONE
	) {
		return false;
	}
	return hasAllReleaseArchives(release);
}

/** 从候选列表中选出最近一条补更目标（按 createdAt）；无候选时返回 null。 */
export function selectLatestCatchUpTarget(
	releases: ReleaseInfo[],
): ReleaseInfo | null {
	let latest: ReleaseInfo | null = null;
	let latestAt = Number.NEGATIVE_INFINITY;
	for (const release of releases) {
		if (!isCatchUpTarget(release)) continue;
		const at = Date.parse(release.createdAt);
		if (!Number.isFinite(at) || at <= latestAt) continue;
		latest = release;
		latestAt = at;
	}
	return latest;
}

/** Release 清理固定策略。 */
export interface ReleaseCleanupPolicy {
	successfulReleaseCount: 3;
	minimumAgeDays: 30;
	uploadSessionGraceHours: 24;
}

/** Release 清理预览中的归档候选。 */
export interface ReleaseCleanupArchiveCandidate {
	version: string;
	status: ReleaseStatus;
	archives: Array<{
		platform: ReleasePlatform;
		bytes: number;
		providerState: "ready" | "provider_unavailable";
	}>;
	bytes: number;
	reason: "retention_policy";
}

/** Release 清理预览结果。 */
export interface ReleaseCleanupPreview {
	policy: ReleaseCleanupPolicy;
	candidates: ReleaseCleanupArchiveCandidate[];
	expiredUploadSessions: { count: number; bytes: number };
	estimatedReclaimableBytes: number;
}

/** Release 清理执行中的安全问题摘要。 */
export interface ReleaseCleanupIssue {
	version?: string;
	platform?: ReleasePlatform;
	code: string;
}

/** Release 清理执行结果。 */
export interface ReleaseCleanupRunResult {
	startedAt: string;
	finishedAt: string;
	cleanedItems: number;
	cleanedBytes: number;
	alreadyMissing: number;
	failed: number;
	skipped: number;
	providerUnavailable: number;
	retryable: boolean;
	issues: ReleaseCleanupIssue[];
}

/** 由客户端注册的 os 字符串（如 "win32 10.0.26200"）映射到发布平台，未知平台返回 null */
export function platformFromOs(
	os: string | undefined | null,
): ReleasePlatform | null {
	if (!os) return null;
	const lower = os.toLowerCase();
	if (lower.startsWith("win32") || lower === "win") return "win-x64";
	if (lower.startsWith("linux")) return "linux-x64";
	return null;
}

/** release 列表项（REST 返回） */
export interface ReleaseInfo {
	version: string;
	/** 平台 -> 构件信息（上传两个平台后完整；缺失平台的目标机无法更新） */
	archives: Partial<Record<ReleasePlatform, ReleaseArchiveInfo>>;
	status: ReleaseStatus;
	errorMessage?: string | null;
	/** 发版操作者（上传者身份；由 AuthGuard 注入） */
	createdByName?: string | null;
	createdVia?: string | null;
	createdAt: string;
	updatedAt: string;
	/** clientId -> 更新条目（JSON 字符串在 DB，API 层解析为对象） */
	clientStates: Record<string, ReleaseClientEntry>;
}
