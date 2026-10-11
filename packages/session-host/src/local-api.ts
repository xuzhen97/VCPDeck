import http from "node:http";
import {
	type SessionHostErrorCode,
	SessionHostProtocolError,
	parseSessionHostStartRequest,
	parseSessionHostStopRequest,
} from "@vcpdeck/shared";
import { SessionHostOperationError, type InstanceRegistry } from "./instance-registry.js";
import { isAuthenticatedLocalRequest } from "./local-auth.js";
import { SnapshotTooLargeError } from "./pty-session.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;

/** 本机接口装配参数。令牌由宿主启动时生成，不落盘复用。 */
export interface LocalApiOptions {
	registry: InstanceRegistry;
	token: string;
	hostId: string;
	maxBodyBytes?: number;
	maxInputBytes?: number;
}

/** 请求体超过上限。与协议错误区分，以便映射成 413 而不是 400。 */
class BodyTooLargeError extends Error {}

/**
 * 创建宿主的本机接口。
 *
 * 安全边界要点：
 * - 认证在路由与实例匹配之前，未认证请求不得触发任何实例操作；
 * - 响应与日志不含令牌、工作目录或请求正文，因此这里刻意不打印任何内容；
 * - 错误只暴露稳定错误码与固定文案，不回显调用方输入。
 */
export function createLocalApi(options: LocalApiOptions): http.Server {
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;

	async function readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let aborted = false;
			req.on("data", (chunk: Buffer) => {
				// 越限后继续消费剩余数据：半读的请求体会污染 keep-alive 连接。
				if (aborted) return;
				size += chunk.length;
				if (size > maxBodyBytes) {
					aborted = true;
					reject(new BodyTooLargeError());
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
			});
			req.on("error", (error) => {
				if (!aborted) reject(error);
			});
		});
	}

	async function readJson(req: http.IncomingMessage): Promise<unknown> {
		const text = await readBody(req);
		if (text.length === 0) throw new SessionHostProtocolError("请求体不能为空");
		try {
			return JSON.parse(text);
		} catch {
			throw new SessionHostProtocolError("请求体不是合法 JSON");
		}
	}

	function requireInstance(instanceId: string) {
		const record = options.registry.get(instanceId);
		if (record === undefined) {
			throw new SessionHostOperationError("SESSION_HOST_INSTANCE_NOT_FOUND", "实例不存在或已结束");
		}
		if (record.session.state !== "running") {
			throw new SessionHostOperationError("SESSION_HOST_INSTANCE_CONFLICT", "实例不在运行状态");
		}
		return record;
	}

	function parseInstanceField(body: unknown, what: string): string {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			throw new SessionHostProtocolError(`${what} 必须是对象`);
		}
		const instanceId = (body as Record<string, unknown>).instanceId;
		if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 128) {
			throw new SessionHostProtocolError(`${what}.instanceId 非法`);
		}
		return instanceId;
	}

	async function route(req: http.IncomingMessage, url: URL): Promise<{ status: number; body: unknown }> {
		const method = req.method ?? "";
		const key = `${method} ${url.pathname}`;

		if (key === "GET /identity") {
			return { status: 200, body: { hostId: options.hostId, protocolVersion: PROTOCOL_VERSION } };
		}
		if (key === "GET /status") {
			return {
				status: 200,
				body: { available: true, hostId: options.hostId, instances: options.registry.list() },
			};
		}
		if (key === "POST /start") {
			const request = parseSessionHostStartRequest(await readJson(req));
			const result = options.registry.start(request);
			return { status: 200, body: { hostId: options.hostId, instanceId: result.instanceId, reused: result.reused } };
		}
		if (key === "POST /stop") {
			const { instanceId } = parseSessionHostStopRequest(await readJson(req));
			const { exited } = await options.registry.stop(instanceId);
			return { status: 200, body: { hostId: options.hostId, instanceId, exited } };
		}
		if (key === "POST /snapshot") {
			const body = await readJson(req);
			const instanceId = parseInstanceField(body, "sessionHost.snapshot");
			// 快照允许读取已停止实例的最后一屏，因此只要求存在，不要求仍在运行。
			const record = options.registry.get(instanceId);
			if (record === undefined) {
				throw new SessionHostOperationError("SESSION_HOST_INSTANCE_NOT_FOUND", "实例不存在或已结束");
			}
			const snapshot = await record.session.snapshot();
			return { status: 200, body: { hostId: options.hostId, instanceId, ...snapshot } };
		}
		if (key === "POST /input") {
			const body = await readJson(req);
			const instanceId = parseInstanceField(body, "sessionHost.input");
			const record = requireInstance(instanceId);
			const data = (body as Record<string, unknown>).data;
			if (typeof data !== "string") throw new SessionHostProtocolError("sessionHost.input.data 必须是字符串");
			if (Buffer.byteLength(data, "utf8") > maxInputBytes) {
				return { status: 413, body: { error: { message: "输入超过上限" } } };
			}
			record.session.write(data);
			return { status: 200, body: { hostId: options.hostId, instanceId, accepted: true } };
		}
		if (key === "POST /resize") {
			const body = await readJson(req);
			const instanceId = parseInstanceField(body, "sessionHost.resize");
			const record = requireInstance(instanceId);
			const cols = (body as Record<string, unknown>).cols;
			const rows = (body as Record<string, unknown>).rows;
			const sizeOk =
				typeof cols === "number" &&
				typeof rows === "number" &&
				Number.isInteger(cols) &&
				Number.isInteger(rows) &&
				cols >= MIN_COLS &&
				cols <= MAX_COLS &&
				rows >= MIN_ROWS &&
				rows <= MAX_ROWS;
			if (!sizeOk) throw new SessionHostProtocolError("sessionHost.resize 尺寸非法");
			record.session.resize(cols as number, rows as number);
			return { status: 200, body: { hostId: options.hostId, instanceId, cols, rows } };
		}
		return { status: 404, body: { error: { message: "未知操作" } } };
	}

	function statusForOperationError(code: SessionHostErrorCode): number {
		switch (code) {
			case "SESSION_HOST_INSTANCE_NOT_FOUND":
				return 404;
			case "SESSION_HOST_INSTANCE_CONFLICT":
			case "SESSION_HOST_INSTANCE_LIMIT_REACHED":
			case "SESSION_HOST_OUTPUT_BACKLOG_EXCEEDED":
			case "SESSION_HOST_NOT_CONFIRMED":
				return 409;
			default:
				return 500;
		}
	}

	function send(res: http.ServerResponse, status: number, body: unknown): void {
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
	}

	return http.createServer((req, res) => {
		void (async () => {
			// 认证必须先于一切：未认证请求连路由都不该知道，更不得触碰实例。
			if (!isAuthenticatedLocalRequest(req.headers.authorization, options.token)) {
				send(res, 401, { error: { message: "未认证" } });
				return;
			}
			let url: URL;
			try {
				url = new URL(req.url ?? "", "http://127.0.0.1");
			} catch {
				send(res, 400, { error: { code: "SESSION_HOST_PROTOCOL_INVALID", message: "请求目标非法" } });
				return;
			}
			if (url.search.length > 0) {
				send(res, 400, { error: { code: "SESSION_HOST_PROTOCOL_INVALID", message: "不接受查询参数" } });
				return;
			}
			try {
				const result = await route(req, url);
				send(res, result.status, result.body);
			} catch (error) {
				if (error instanceof BodyTooLargeError) {
					send(res, 413, { error: { message: "请求体超过上限" } });
					return;
				}
				if (error instanceof SnapshotTooLargeError) {
					send(res, 413, { error: { message: "画面快照超过上限" } });
					return;
				}
				if (error instanceof SessionHostProtocolError) {
					send(res, 400, { error: { code: "SESSION_HOST_PROTOCOL_INVALID", message: "请求不符合协议" } });
					return;
				}
				if (error instanceof SessionHostOperationError) {
					send(res, statusForOperationError(error.code), { error: { code: error.code, message: "会话宿主操作失败" } });
					return;
				}
				send(res, 500, { error: { message: "会话宿主内部错误" } });
			}
		})();
	});
}
