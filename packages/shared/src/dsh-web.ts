/**
 * 远程 DSH WebUI 的受管生命周期契约（ADR-0059 修订）。
 *
 * VCPDeck 代操作者在目标机启动 `dsh --profile web`，再为该端口建 FRP 映射，
 * 于是"一键启动 → 点开 → 一键停止"闭环，操作者不需要手写命令行。
 *
 * 这是 Server ↔ Client 的受控命令，不是公开 API：token 只在 Server 与 Client
 * 之间传递一次，随后由 Server 拼进 `dshWebUrl` 并只经登录后的 API 下发。
 */

/** Client 声明的"可代为管理本地 dsh web"能力。 */
export const DSH_WEB_CAPABILITY = "dsh-web";

/** 远程 DSH 通道状态。 */
export const DSH_WEB_STATES = [
	"stopped",
	"starting",
	"running",
	"failed",
] as const;
export type DshWebState = (typeof DSH_WEB_STATES)[number];

/** Server → Client 命令。 */
export interface DshWebCommand {
	requestId: string;
	action: "start" | "stop";
	clientId: string;
	/** start 时要求监听的端口（由 Server 分配，1–65535）。 */
	port: number;
}

/** Client → Server 结果。 */
export interface DshWebCommandResult {
	requestId: string;
	ok: boolean;
	/** start 成功后实际监听端口。 */
	port?: number;
	/** start 成功后 `dsh web` 打印的一次性 token（不写日志）。 */
	token?: string;
	error?: { code: string; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
	value: unknown,
	field: string,
	maxLength: number,
): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new Error(`${field} 必须为长度 1-${maxLength} 的字符串`);
	}
	return value;
}

function requirePort(value: unknown, field: string): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1024 ||
		value > 65535
	) {
		throw new Error(`${field} 必须为 1024-65535 的整数`);
	}
	return value;
}

/** 严格解析 Server → Client 命令。 */
export function parseDshWebCommand(value: unknown): DshWebCommand {
	if (!isRecord(value)) throw new Error("dshweb 命令必须为对象");
	const allowed = new Set(["requestId", "action", "clientId", "port"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`dshweb 命令含未知字段 ${key}`);
	}
	const requestId = requireString(value.requestId, "requestId", 128);
	const clientId = requireString(value.clientId, "clientId", 128);
	if (value.action !== "start" && value.action !== "stop") {
		throw new Error("dshweb 命令 action 必须是 start 或 stop");
	}
	return {
		requestId,
		action: value.action,
		clientId,
		port: requirePort(value.port, "port"),
	};
}

/** 严格解析 Client → Server 结果。 */
export function parseDshWebCommandResult(value: unknown): DshWebCommandResult {
	if (!isRecord(value)) throw new Error("dshweb 结果必须为对象");
	const allowed = new Set([
		"requestId",
		"ok",
		"port",
		"token",
		"error",
	]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`dshweb 结果含未知字段 ${key}`);
	}
	const requestId = requireString(value.requestId, "requestId", 128);
	if (typeof value.ok !== "boolean") throw new Error("dshweb 结果 ok 必须为布尔值");
	const result: DshWebCommandResult = { requestId, ok: value.ok };
	if (value.port !== undefined) {
		result.port = requirePort(value.port, "port");
	}
	if (value.token !== undefined) {
		result.token = requireString(value.token, "token", 512);
	}
	if (value.error !== undefined) {
		if (!isRecord(value.error)) throw new Error("error 必须为对象");
		result.error = {
			code: requireString(value.error.code, "error.code", 128),
			message: requireString(value.error.message, "error.message", 2000),
		};
	}
	return result;
}
