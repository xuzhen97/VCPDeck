/**
 * Launcher 本地控制通道服务端。
 * 详见 docs/design/release-and-update.md。
 * 监听 127.0.0.1 随机端口 + 随机 token，写 control.json 供被守护进程调用：
 * - POST /prepare：受理后台下载/校验/解压/组装（服务进程仍在运行）
 * - GET /prepare/status：查询后台 prepare 状态
 * - POST /apply：停掉本进程并切换版本（响应可能无法送达，属正常）
 * preStart 钩子（如 prisma db push）在切换前由编排侧调用 runPreStart。
 */
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type {
	LauncherPrepareStatus,
	ReleaseDeltaCandidate,
} from "@vcpdeck/shared";

const execFileAsync = promisify(execFile);

export interface ControlHandlers {
	prepare(input: {
		version: string;
		url: string;
		sha256: string;
		candidates?: ReleaseDeltaCandidate[];
	}): Promise<void>;
	apply(): Promise<void>;
	/** 后台 prepare 状态快照；/apply 仅在 ready 时放行 */
	prepareStatus(): LauncherPrepareStatus;
}

export interface ControlServerOptions {
	handlers: ControlHandlers;
	/** control.json 路径 */
	controlFile: string;
	token?: string;
	log?: (msg: string) => void;
}

export interface ControlServerHandle {
	port: number;
	token: string;
	close(): Promise<void>;
}

/** 候选增量包为跨信任边界输入，逐项校验后透传，不宽松猜测字段。 */
function parseCandidates(
	value: unknown,
): ReleaseDeltaCandidate[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("candidates 必须是数组");
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("candidates 条目无效");
		}
		const c = item as Record<string, unknown>;
		if (
			typeof c.fromVersion !== "string" ||
			typeof c.url !== "string" ||
			typeof c.sha256 !== "string" ||
			typeof c.size !== "number" ||
			!Number.isFinite(c.size) ||
			c.size < 0
		) {
			throw new Error("candidates 条目字段无效");
		}
		return {
			fromVersion: c.fromVersion,
			url: c.url,
			sha256: c.sha256,
			size: c.size,
		};
	});
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk: string) => {
			raw += chunk;
			if (raw.length > 1024 * 1024) {
				reject(new Error("请求体过大"));
				req.destroy();
			}
		});
		req.on("end", () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch (e) {
				reject(new Error(`请求体 JSON 无效: ${(e as Error).message}`));
			}
		});
		req.on("error", reject);
	});
}

function respond(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** 启动控制通道 HTTP 服务并写 control.json */
export async function createControlServer(
	options: ControlServerOptions,
): Promise<ControlServerHandle> {
	const token = options.token ?? randomUUID();
	const log = options.log ?? (() => undefined);

	const server = createServer(async (req, res) => {
		if (req.headers["x-launcher-token"] !== token) {
			respond(res, 401, { code: "UNAUTHORIZED", message: "token 无效" });
			return;
		}
		try {
			if (req.method === "POST" && req.url === "/prepare") {
				const body = (await readJsonBody(req)) as {
					version?: string;
					url?: string;
					sha256?: string;
					candidates?: unknown;
				};
				if (!body.version || !body.url || !body.sha256) {
					respond(res, 400, {
						code: "BAD_REQUEST",
						message: "缺少 version/url/sha256",
					});
					return;
				}
				let candidates: ReleaseDeltaCandidate[] | undefined;
				try {
					candidates = parseCandidates(body.candidates);
				} catch {
					respond(res, 400, {
						code: "BAD_REQUEST",
						message: "candidates 无效",
					});
					return;
				}
				await options.handlers.prepare({
					version: body.version,
					url: body.url,
					sha256: body.sha256,
					...(candidates ? { candidates } : {}),
				});
				respond(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && req.url === "/prepare/status") {
				respond(res, 200, options.handlers.prepareStatus());
				return;
			}
			if (req.method === "POST" && req.url === "/apply") {
				const status = options.handlers.prepareStatus();
				if (status.state !== "ready" && status.state !== "preparing") {
					respond(res, 409, {
						code: status.errorCode ?? "ASSEMBLE_FAILED",
						message:
							status.state === "failed" ? "版本准备失败" : "版本尚未准备就绪",
					});
					return;
				}
				// /prepare 已改为后台受理后立即返回；只发一次 /prepare 就调用
				// /apply 的旧 Server 不会轮询 /prepare/status，这里等后台任务
				// 结束，保持旧的同步语义。
				if (status.state === "preparing") {
					log(`[launcher] apply 等待 prepare 完成: ${status.version ?? ""}`);
				}
				try {
					await options.handlers.apply();
				} catch (e) {
					const code = (e as { code?: unknown }).code;
					if (typeof code !== "string") throw e;
					respond(res, 409, {
						code,
						message: e instanceof Error ? e.message : String(e),
					});
					return;
				}
				respond(res, 200, { ok: true });
				return;
			}
			respond(res, 404, { code: "NOT_FOUND", message: "未知路径" });
		} catch (e) {
			log(`[launcher] 控制通道请求失败: ${(e as Error).message}`);
			respond(res, 500, {
				code: "INTERNAL",
				message: e instanceof Error ? e.message : String(e),
			});
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address() as AddressInfo;

	await writeFile(
		options.controlFile,
		JSON.stringify({ port: address.port, token, pid: process.pid }),
		"utf-8",
	);
	log(`[launcher] 控制通道已监听 127.0.0.1:${address.port}`);

	return {
		port: address.port,
		token,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}

/**
 * preStart 钩子：切换版本前在构件目录执行（如 prisma db push）。
 * 命令为空时跳过；失败抛错（含命令摘要，不含输出细节）。
 */
export async function runPreStart(
	cmd: string | undefined,
	cwd: string,
	execImpl: typeof execFileAsync = execFileAsync,
): Promise<void> {
	if (!cmd) return;
	try {
		await execImpl(cmd, { cwd, shell: true, timeout: 120_000 });
	} catch {
		throw new Error(`preStart 失败: ${cmd}`);
	}
}
