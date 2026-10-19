import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { resolveSpawnTarget } from "./windows-launcher.js";

export interface AcpProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	onNotification: (message: AcpJsonRpcNotification) => void;
	onRequest: (message: AcpJsonRpcRequest) => Promise<unknown>;
	onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
	maxLineBytes?: number;
	requestTimeoutMs?: number;
}

export interface AcpJsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: unknown;
}

export interface AcpJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface AcpJsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface AcpProcess {
	request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
	notify(method: string, params?: unknown): void;
	kill(): Promise<void>;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function acpError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function errorText(error: unknown): string {
	const message = (error as { message?: unknown })?.message;
	return typeof message === "string" && message.length > 0
		? message.slice(0, 200)
		: "ACP request failed";
}

/** 启动一个 ACP agent 子进程，按 NDJSON 进行 JSON-RPC 关联。 */
export function spawnAcpProcess(options: AcpProcessOptions): AcpProcess {
	// Windows 上 .cmd/.bat 垫片不能直接 spawn，需按解析结果经 cmd.exe 包装
	const target = resolveSpawnTarget({
		command: options.command,
		args: options.args,
		env: options.env,
	});
	const child: ChildProcessWithoutNullStreams = spawn(
		target.command,
		target.args,
		{
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: target.windowsVerbatimArguments,
		},
	);
	const pending = new Map<string, Pending>();
	const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
	const defaultTimeout = options.requestTimeoutMs ?? 30_000;
	let nextId = 0;
	let closed = false;
	let exitNotified = false;

	const exitPromise = new Promise<void>((resolve) => {
		const finish = (
			code: number | null,
			signal: NodeJS.Signals | null,
		): void => {
			if (closed) return;
			closed = true;
			for (const [key, entry] of pending) {
				clearTimeout(entry.timer);
				pending.delete(key);
				entry.reject(acpError("ACP_PROCESS_EXITED", "ACP agent exited"));
			}
			if (!exitNotified) {
				exitNotified = true;
				options.onExit({ code, signal });
			}
			resolve();
		};
		child.once("exit", (code, signal) => finish(code, signal));
		child.once("close", (code, signal) => finish(code, signal));
		child.once("error", () => finish(null, null));
	});

	const send = (value: unknown): void => {
		if (closed || !child.stdin.writable) {
			throw acpError("ACP_PROCESS_EXITED", "ACP agent is not running");
		}
		child.stdin.write(`${JSON.stringify(value)}\n`);
	};

	const respond = (id: string | number, result: unknown): void => {
		send({ jsonrpc: "2.0", id, result: result ?? null });
	};

	const respondError = (id: string | number, message: string): void => {
		send({
			jsonrpc: "2.0",
			id,
			error: { code: -32603, message: message.slice(0, 200) },
		});
	};

	const rl = readline.createInterface({
		input: child.stdout,
		crlfDelay: Infinity,
	});
	rl.on("line", (line) => {
		if (line.length === 0) return;
		if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
			child.kill();
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null) return;
		const record = message as Record<string, unknown>;
		if (
			record.id !== undefined &&
			typeof record.id !== "string" &&
			typeof record.id !== "number"
		) {
			return;
		}
		if (record.id !== undefined && record.method === undefined) {
			const entry = pending.get(String(record.id));
			if (!entry) return;
			clearTimeout(entry.timer);
			pending.delete(String(record.id));
			if (record.error !== undefined) {
				const error = record.error as { message?: unknown };
				entry.reject(
					acpError(
						"ACP_RPC_ERROR",
						typeof error.message === "string"
							? error.message.slice(0, 200)
							: "ACP RPC error",
					),
				);
				return;
			}
			entry.resolve(record.result);
			return;
		}
		if (record.id !== undefined && typeof record.method === "string") {
			const request = record as unknown as AcpJsonRpcRequest;
			void options
				.onRequest(request)
				.then((result) => respond(request.id, result))
				.catch((error: unknown) =>
					respondError(request.id, errorText(error)),
				);
			return;
		}
		if (typeof record.method === "string") {
			options.onNotification(
				record as unknown as AcpJsonRpcNotification,
			);
		}
	});

	// stderr 不进入业务；只保留进程退出观察。
	child.stderr.on("data", () => undefined);

	return {
		request(method, params, timeoutMs = defaultTimeout) {
			if (closed) {
				return Promise.reject(
					acpError("ACP_PROCESS_EXITED", "ACP agent is not running"),
				);
			}
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(String(id));
					reject(acpError("ACP_TIMEOUT", "ACP request timed out"));
				}, timeoutMs);
				pending.set(String(id), { resolve, reject, timer });
				try {
					send({ jsonrpc: "2.0", id, method, params: params ?? {} });
				} catch (error) {
					clearTimeout(timer);
					pending.delete(String(id));
					reject(error);
				}
			});
		},
		notify(method, params) {
			send({ jsonrpc: "2.0", method, params: params ?? {} });
		},
		async kill() {
			if (!closed) child.kill();
			await Promise.race([
				exitPromise,
				new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
			]);
			rl.close();
		},
	};
}
