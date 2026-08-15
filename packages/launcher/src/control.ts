/**
 * 本地控制通道服务端（设计文档 §6.3）。
 * 监听 127.0.0.1 随机端口 + 随机 token，写 control.json 供被守护进程调用：
 * - POST /prepare：下载/校验/解压新版本（服务进程仍在运行）
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

const execFileAsync = promisify(execFile);

export interface ControlHandlers {
	prepare(input: {
		version: string;
		url: string;
		sha256: string;
	}): Promise<void>;
	apply(): Promise<void>;
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
				};
				if (!body.version || !body.url || !body.sha256) {
					respond(res, 400, {
						code: "BAD_REQUEST",
						message: "缺少 version/url/sha256",
					});
					return;
				}
				await options.handlers.prepare({
					version: body.version,
					url: body.url,
					sha256: body.sha256,
				});
				respond(res, 200, { ok: true });
				return;
			}
			if (req.method === "POST" && req.url === "/apply") {
				await options.handlers.apply();
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
