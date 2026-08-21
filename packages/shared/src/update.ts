// ── 自更新协议（server ↔ client 经 WebSocket，launcher 经本地控制通道） ──
// 详见 docs/design/release-and-update.md

/** 更新包 manifest（打包时生成，随 archive 携带） */
export interface UpdateManifest {
	version: string;
	/** 所需 Node 版本约束（如 ">=24"），launcher ensure-node 使用 */
	nodeVersion: string;
	/** launcher 最低兼容版本（当前字段预留，尚未执行校验） */
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
}

/** 服务端 → 客户端：请求更新（含下载地址与校验值） */
export interface UpdateRequest {
	releaseVersion: string;
	/** 更新包下载 URL（客户端 launcher 使用） */
	url: string;
	sha256: string;
	/** 优雅停机等待上限（ms），缺省 10 分钟 */
	timeoutMs?: number;
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

/** 单客户端更新条目（含失败原因与时间戳，审计用） */
export interface ReleaseClientEntry {
	state: ReleaseClientState;
	/** 失败原因摘要（仅 failed 时非空，安全脱敏） */
	reason?: string;
	/** 最后状态变更时间（ISO 字符串） */
	at: string;
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

/** 创建 Release 上传会话的严格输入。 */
export interface ReleaseUploadCreateInput {
	version: string;
	platform: ReleasePlatform;
	sha256: string;
	size: number;
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
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["version", "platform", "sha256", "size"])
	) {
		throw new Error("body 必须且只能包含 version/platform/sha256/size");
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
	return {
		version: value.version,
		platform: value.platform,
		sha256: value.sha256,
		size: value.size,
	};
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

/** 单个平台的发布构件信息（校验值与体积） */
export interface ReleaseArchiveInfo {
	sha256: string;
	size: number;
	fileName: string;
	/** 外部存储直连信息（ADR-0019；Local 后端无此字段） */
	storage?: ReleaseArchiveStorage;
}

/** 发布构件存储信息（ADR-0019：外部存储上传/下载双向直连）
 *  Local 后端无此字段；目标机经统一入口 302 直连存储下载。 */
export interface ReleaseArchiveStorage {
	/** 存储后端 kind（local / alibaba 等） */
	provider: string;
	/** 后端内对象 key（阿里云盘为 fileId） */
	key: string;
	/** 分发模式：direct = 目标机经统一入口 302 直连存储 */
	mode: "direct";
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
