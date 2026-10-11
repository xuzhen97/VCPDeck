import { readFile } from "node:fs/promises";
import {
	type SessionHostErrorCode,
	type SessionHostInstanceInfo,
	type SessionHostKind,
	type SessionHostStatusReport,
	parseSessionHostStartRequest,
	parseSessionHostStopRequest,
	parseSessionHostStatusReport,
} from "@vcpdeck/shared";

/** 默认请求超时。超时即视为「宿主暂时不可达」，绝不重发启动请求。 */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 宿主不可达（控制文件缺失/非法、连接失败、超时、响应非法）时的统一报告。
 *
 * `available: false` 与「实例都已停止」是两件事：这里只表达「状态未确认」。
 */
const UNAVAILABLE_REPORT: SessionHostStatusReport = { available: false, hostId: null, instances: [] };

/** 客户端侧会话宿主错误。只在无法确认状态时抛出，不用于「未确认退出」这类可返回值的情况。 */
export class SessionHostClientError extends Error {
	readonly code: SessionHostErrorCode;
	constructor(code: SessionHostErrorCode, message: string) {
		super(message);
		this.name = "SessionHostClientError";
		this.code = code;
	}
}

export interface SessionHostClientOptions {
	/** 宿主写出的控制文件路径（由部署提供）。 */
	controlFile: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export interface SessionHostClient {
	/** 读取宿主状态。宿主不可达时返回 `available: false`，不抛错。 */
	status(): Promise<SessionHostStatusReport>;
	/** 启动实例。宿主不可达或响应自称的实例不存在时明确失败。 */
	start(request: { operationId: string; kind: SessionHostKind; cwd: string }): Promise<SessionHostInstanceInfo>;
	/** 请求停止。宿主未确认退出（含不可达/超时）时返回 `exited: false`。 */
	stop(instanceId: string): Promise<{ exited: boolean }>;
}

interface ControlFileContent {
	port: number;
	token: string;
	hostId: string;
}

/** 严格读取控制文件：字段多余、缺失或类型不对都视为不可用。 */
function parseControlFile(raw: string): ControlFileContent | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 3 || !keys.every((key) => key === "port" || key === "token" || key === "hostId")) return null;
	const { port, token, hostId } = record;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
	if (typeof token !== "string" || token.length === 0) return null;
	if (typeof hostId !== "string" || hostId.length === 0) return null;
	return { port, token, hostId };
}

/**
 * 创建本机接口客户端。
 *
 * 每次调用都重新读取控制文件：宿主重启会换端口与新令牌，
 * 缓存旧内容等于把「新宿主」当成「旧宿主不可达」。
 */
export function createSessionHostClient(options: SessionHostClientOptions): SessionHostClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	async function readControlFile(): Promise<ControlFileContent | null> {
		try {
			return parseControlFile(await readFile(options.controlFile, "utf8"));
		} catch {
			return null;
		}
	}

	async function call(route: string, body?: unknown): Promise<unknown | null> {
		const control = await readControlFile();
		if (control === null) return null;
		try {
			const response = await fetchImpl(`http://127.0.0.1:${control.port}${route}`, {
				method: body === undefined ? "GET" : "POST",
				headers:
					body === undefined
						? { authorization: `Bearer ${control.token}` }
						: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.status !== 200) return null;
			return await response.json();
		} catch {
			// 连接失败、超时、响应不是 JSON：都归入「暂时不可达」。
			return null;
		}
	}

	async function status(): Promise<SessionHostStatusReport> {
		const body = await call("/status");
		if (body === null) return UNAVAILABLE_REPORT;
		try {
			return parseSessionHostStatusReport(body);
		} catch {
			return UNAVAILABLE_REPORT;
		}
	}

	return {
		status,

		async start(request) {
			// 先在本地严格校验：非法输入不得离开本进程。
			const parsed = parseSessionHostStartRequest(request);
			const body = await call("/start", parsed);
			if (body === null) {
				throw new SessionHostClientError("SESSION_HOST_UNAVAILABLE", "会话宿主不可达");
			}
			const record = body as Record<string, unknown>;
			const instanceId = record.instanceId;
			if (typeof instanceId !== "string" || instanceId.length === 0) {
				throw new SessionHostClientError("SESSION_HOST_PROTOCOL_INVALID", "会话宿主启动响应非法");
			}
			// 实例信息只认状态报告里的严格解析结果，不采信启动响应里的自述。
			const report = await status();
			const instance = report.instances.find((item) => item.instanceId === instanceId);
			if (instance === undefined) {
				throw new SessionHostClientError("SESSION_HOST_UNAVAILABLE", "会话宿主未确认该实例");
			}
			return instance;
		},

		async stop(instanceId) {
			const parsed = parseSessionHostStopRequest({ instanceId });
			const body = await call("/stop", parsed);
			if (body === null) return { exited: false };
			return { exited: (body as { exited?: unknown }).exited === true };
		},
	};
}
