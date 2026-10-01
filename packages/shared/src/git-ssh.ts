/**
 * Git SSH 共享密钥分发协议（Server ↔ Client）。
 *
 * 权威边界见 docs/adr/0037 与 docs/adr/0038：
 * - Server 生成并加密保存一套密钥，Client 在专用目录安装受管副本；
 * - 私钥正文只出现在 Server → Client 的 install 指令中，绝不进入 REST 响应、日志或 Job；
 * - 共享 PSK 下的选机只是运维范围，本协议不提供每机身份认证。
 *
 * 解析风格与 `pi.ts`/`pi-bundle.ts` 一致：未知键、未知版本、非法长度一律 fail closed。
 */

/** 协议版本；Server 与 Client 必须精确匹配。 */
export const GIT_SSH_PROTOCOL_VERSION = 1;

/** 单次批量选机上限（防止异常请求撑爆存储与 UI）。 */
export const GIT_SSH_MAX_TARGETS = 200;

/** install 指令中私钥装甲的长度上限。 */
const MAX_PRIVATE_KEY_LENGTH = 8192;
/** OpenSSH 公钥单行长度上限。 */
const MAX_PUBLIC_KEY_LENGTH = 512;
/** 操作 ID 长度上限。 */
const MAX_OPERATION_ID_LENGTH = 64;
/** Client ID 长度上限（与机器注册保持一致）。 */
const MAX_CLIENT_ID_LENGTH = 128;

/** 稳定失败码（Client → Server 回执与 Server 状态投影共用）。 */
export const GIT_SSH_FAILURE_CODES = [
	"GIT_SSH_KEY_UNAVAILABLE",
	"GIT_SSH_INSTALL_FAILED",
	"GIT_SSH_CLEAR_FAILED",
	"GIT_SSH_UNSUPPORTED",
] as const;

export type GitSshFailureCode = (typeof GIT_SSH_FAILURE_CODES)[number];

/** 稳定协议错误：Server 映射为 400，Client 直接拒绝该消息。 */
export class GitSshProtocolError extends Error {
	readonly code = "GIT_SSH_PROTOCOL_INVALID";
	constructor(message: string) {
		super(message);
		this.name = "GitSshProtocolError";
	}
}

function fail(message: string): never {
	throw new GitSshProtocolError(message);
}

function assertRecord(
	value: unknown,
	what: string,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${what} 必须是对象`);
	}
}

/** 未知键与缺失键都拒绝，避免「Server 认为已生效、Client 未执行」的静默偏移。 */
function assertExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	what: string,
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) fail(`${what} 含未知字段 ${key}`);
	}
	for (const key of allowed) {
		if (!(key in value)) fail(`${what} 缺少字段 ${key}`);
	}
}

function requireBoundedString(
	value: unknown,
	what: string,
	maxLength: number,
): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		fail(`${what} 必须为长度 1-${maxLength} 的字符串`);
	}
	return value;
}

function requirePositiveInt(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		fail(`${what} 必须为正整数`);
	}
	return value;
}

function requireProtocolVersion(value: unknown): 1 {
	if (value !== GIT_SSH_PROTOCOL_VERSION) {
		fail(`protocolVersion 不支持：${String(value)}`);
	}
	return GIT_SSH_PROTOCOL_VERSION;
}

/** OpenSSH 私钥装甲：只接受未加密的 `OPENSSH PRIVATE KEY` 块。 */
const OPENSSH_PRIVATE_KEY_PATTERN =
	/^-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]+-----END OPENSSH PRIVATE KEY-----\s*$/;

/** 生成的公钥固定为 Ed25519 单行，不接受注释或额外字段。 */
const OPENSSH_PUBLIC_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;

/** Client 上报能力摘要：可用时必须协议版本匹配，不可用时必须携带稳定原因码。 */
export type GitSshCapability =
	| { available: true; protocolVersion: number }
	| { available: false; code: "GIT_SSH_UNAVAILABLE" };

/** Server → Client install 指令（唯一携带私钥正文的消息）。 */
export interface GitSshInstallCommand {
	protocolVersion: 1;
	operationId: string;
	version: number;
	action: "install";
	privateKey: string;
	publicKey: string;
}

/** Server → Client clear 指令：要求 Client 清理受管副本。 */
export interface GitSshClearCommand {
	protocolVersion: 1;
	operationId: string;
	version: number;
	action: "clear";
}

export type GitSshCommand = GitSshInstallCommand | GitSshClearCommand;

/**
 * Client → Server 回执。
 * `installed`/`cleared` 只表示本地受管副本状态，**不代表 Git 服务已授权或已撤销**。
 *
 * 判别联合：`failed` 必须携带稳定失败码（与 `parseGitSshAck` 的运行时要求一致），
 * 成功态不得携带 `code`，避免出现“能过类型检查却在运行时被拒”的构造。
 */
export type GitSshAck =
	| {
			protocolVersion: 1;
			operationId: string;
			version: number;
			state: "installed" | "cleared";
	  }
	| {
			protocolVersion: 1;
			operationId: string;
			version: number;
			state: "failed";
			code: GitSshFailureCode;
	  };

/** 批量选机输入（PUT /api/git-ssh/targets）。 */
export interface GitSshTargetInput {
	clientIds: string[];
}

/** 管理面密钥投影：只暴露公钥与指纹，永不包含密文或私钥。 */
export interface GitSshPublicInfo {
	version: number;
	publicKey: string;
	fingerprint: string;
}

/**
 * 每台 Client 的分发状态。
 * - `pending`：已选机但尚未确认安装；
 * - `installed`：Client 已回报当前版本安装完成；
 * - `clear-pending`：已取消选机，等待 Client 清理确认；
 * - `cleared`：Client 已回报清理完成（不代表 Git 服务已撤销）；
 * - `failed`：Client 回报失败；
 * - `ambiguous`：同一 Client ID 存在重复连接，暂停下发避免误投；
 * - `unsupported`：Client 未上报兼容能力。
 */
export type GitSshTargetState =
	| "pending"
	| "installed"
	| "clear-pending"
	| "cleared"
	| "failed"
	| "ambiguous"
	| "unsupported";

/** 分发状态全集；类型由本元组派生，避免枚举与类型两处手工维护而漂移。 */
export const GIT_SSH_TARGET_STATES = [
	"pending",
	"installed",
	"clear-pending",
	"cleared",
	"failed",
	"ambiguous",
	"unsupported",
] as const satisfies readonly GitSshTargetState[];

/**
 * 运行时守卫：只接受已知分发状态。
 * 持久化列被越界写入（人工改库、未预期迁移）时不得把未知值投影成契约外状态，
 * 也不得让 UI 渲染出空白状态行。
 */
export function isGitSshTargetState(
	value: unknown,
): value is GitSshTargetState {
	return (
		typeof value === "string" &&
		(GIT_SSH_TARGET_STATES as readonly string[]).includes(value)
	);
}

/** 运行时守卫：只接受已知失败码（用于校验持久化的 reasonCode）。 */
export function isGitSshFailureCode(value: unknown): value is GitSshFailureCode {
	return (
		typeof value === "string" &&
		(GIT_SSH_FAILURE_CODES as readonly string[]).includes(value)
	);
}

/** 单机状态投影。 */
export interface GitSshTargetStatus {
	clientId: string;
	desiredVersion: number | null;
	observedVersion: number | null;
	state: GitSshTargetState;
	reasonCode?: GitSshFailureCode;
}

/** 全局状态投影：当前密钥 + 每机分发状态。 */
export interface GitSshStatus {
	key: GitSshPublicInfo | null;
	targets: GitSshTargetStatus[];
}

/** 严格解析 Server → Client 指令。 */
export function parseGitSshCommand(value: unknown): GitSshCommand {
	assertRecord(value, "gitSshCommand");
	if (value.action === "clear") {
		assertExactKeys(
			value,
			["protocolVersion", "operationId", "version", "action"],
			"gitSshCommand",
		);
		return {
			protocolVersion: requireProtocolVersion(value.protocolVersion),
			operationId: requireBoundedString(
				value.operationId,
				"operationId",
				MAX_OPERATION_ID_LENGTH,
			),
			version: requirePositiveInt(value.version, "version"),
			action: "clear",
		};
	}
	if (value.action !== "install") {
		fail(`unknown gitSshCommand action: ${String(value.action)}`);
	}
	assertExactKeys(
		value,
		["protocolVersion", "operationId", "version", "action", "privateKey", "publicKey"],
		"gitSshCommand",
	);
	const { privateKey, publicKey } = value;
	if (
		typeof privateKey !== "string" ||
		privateKey.length > MAX_PRIVATE_KEY_LENGTH ||
		!OPENSSH_PRIVATE_KEY_PATTERN.test(privateKey)
	) {
		fail("privateKey 必须是 OpenSSH 私钥装甲文本");
	}
	if (
		typeof publicKey !== "string" ||
		publicKey.length > MAX_PUBLIC_KEY_LENGTH ||
		!OPENSSH_PUBLIC_KEY_PATTERN.test(publicKey)
	) {
		fail("publicKey 必须是单行 ssh-ed25519 公钥");
	}
	return {
		protocolVersion: requireProtocolVersion(value.protocolVersion),
		operationId: requireBoundedString(
			value.operationId,
			"operationId",
			MAX_OPERATION_ID_LENGTH,
		),
		version: requirePositiveInt(value.version, "version"),
		action: "install",
		privateKey,
		publicKey,
	};
}

/** 严格解析 Client 回执；成功态不得携带失败码。 */
export function parseGitSshAck(value: unknown): GitSshAck {
	assertRecord(value, "gitSshAck");
	const state = value.state;
	if (state === "failed") {
		assertExactKeys(
			value,
			["protocolVersion", "operationId", "version", "state", "code"],
			"gitSshAck",
		);
		if (!(GIT_SSH_FAILURE_CODES as readonly unknown[]).includes(value.code)) {
			fail("gitSshAck.code 必须为已知失败码");
		}
		return {
			protocolVersion: requireProtocolVersion(value.protocolVersion),
			operationId: requireBoundedString(
				value.operationId,
				"operationId",
				MAX_OPERATION_ID_LENGTH,
			),
			version: requirePositiveInt(value.version, "version"),
			state: "failed",
			code: value.code as GitSshFailureCode,
		};
	}
	if (state !== "installed" && state !== "cleared") {
		fail(`gitSshAck.state 必须为 installed、cleared 或 failed：${String(state)}`);
	}
	assertExactKeys(
		value,
		["protocolVersion", "operationId", "version", "state"],
		"gitSshAck",
	);
	return {
		protocolVersion: requireProtocolVersion(value.protocolVersion),
		operationId: requireBoundedString(
			value.operationId,
			"operationId",
			MAX_OPERATION_ID_LENGTH,
		),
		version: requirePositiveInt(value.version, "version"),
		state,
	};
}

/** 严格解析 Client 上报的 Git SSH 能力摘要。 */
export function parseGitSshCapability(value: unknown): GitSshCapability {
	assertRecord(value, "gitSsh");
	if (value.available === true) {
		assertExactKeys(value, ["available", "protocolVersion"], "gitSsh");
		if (value.protocolVersion !== GIT_SSH_PROTOCOL_VERSION) {
			fail(`gitSsh.protocolVersion 不支持：${String(value.protocolVersion)}`);
		}
		return { available: true, protocolVersion: GIT_SSH_PROTOCOL_VERSION };
	}
	if (value.available === false) {
		assertExactKeys(value, ["available", "code"], "gitSsh");
		if (value.code !== "GIT_SSH_UNAVAILABLE") {
			fail("gitSsh.code 必须为 GIT_SSH_UNAVAILABLE");
		}
		return { available: false, code: "GIT_SSH_UNAVAILABLE" };
	}
	fail("gitSsh.available 必须为 boolean");
}

/** 严格解析批量选机输入；重复项与超上限拒绝。 */
export function parseGitSshTargetInput(value: unknown): GitSshTargetInput {
	assertRecord(value, "gitSshTargetInput");
	assertExactKeys(value, ["clientIds"], "gitSshTargetInput");
	const raw = value.clientIds;
	if (!Array.isArray(raw)) {
		fail("clientIds 必须是数组");
	}
	if (raw.length > GIT_SSH_MAX_TARGETS) {
		fail(`clientIds 数量不得超过 ${GIT_SSH_MAX_TARGETS}`);
	}
	const clientIds = raw.map((item, index) =>
		requireBoundedString(item, `clientIds[${index}]`, MAX_CLIENT_ID_LENGTH),
	);
	if (new Set(clientIds).size !== clientIds.length) {
		fail("clientIds 存在重复项");
	}
	return { clientIds };
}
