import { randomUUID } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SessionHostKind } from "@vcpdeck/shared";
import { writeControlFile } from "./control-file.js";
import { type DshProxyTarget, createDshProxy } from "./dsh-proxy.js";
import { createInstanceRegistry, type InstanceRegistry } from "./instance-registry.js";
import { generateAuthToken } from "./local-auth.js";
import { createLocalApi } from "./local-api.js";
import {
	type NativeModuleSet,
	type SessionHostCommand,
	createNativeBackend,
} from "./native-pty.js";
import { type SessionHostPaths, ensureSessionHostPaths, resolveSessionHostPaths } from "./paths.js";
import { createPtySession } from "./pty-session.js";

/** 宿主进程入口的装配参数。启动命令由部署提供，宿主不猜测 Agent 的可执行文件。 */
export interface SessionHostRuntimeOptions {
	paths?: SessionHostPaths;
	commands: Partial<Record<SessionHostKind, SessionHostCommand>>;
	hostId?: string;
	token?: string;
	/** 注入原生模块；缺省时动态加载。 */
	modules?: NativeModuleSet;
	/** 配置后为本机 DSH 提供一个受控入口（loopback 随机端口）。 */
	dshProxy?: { target: DshProxyTarget };
	/** 控制文件路径；缺省为运行时目录下的 control.json（由启动方决定并由其读取）。 */
	controlFile?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	scrollback?: number;
	cols?: number;
	rows?: number;
	createId?: () => string;
}

export interface SessionHostRuntime {
	hostId: string;
	token: string;
	port: number;
	controlFile: string;
	/** DSH 代理监听端口；未配置 DSH 时为 null。 */
	dshProxyPort: number | null;
	registry: InstanceRegistry;
	server: http.Server;
	/** 关闭本机接口、停止全部实例并删除控制文件。重复调用是幂等的。 */
	shutdown(): Promise<void>;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/**
 * 装配并启动会话宿主。
 *
 * 顺序有意为之：先备好稳定目录与原生后端，再监听 loopback 随机端口，
 * 最后才写出控制文件 —— Client 只有在控制文件存在时才认为宿主可用。
 */
export async function startSessionHost(options: SessionHostRuntimeOptions): Promise<SessionHostRuntime> {
	const paths = options.paths ?? resolveSessionHostPaths();
	await ensureSessionHostPaths(paths);

	const backend = await createNativeBackend({
		modules: options.modules,
		commands: options.commands,
		env: options.env,
		platform: options.platform,
		scrollback: options.scrollback,
	});
	const hostId = options.hostId ?? randomUUID();
	const token = options.token ?? generateAuthToken();
	const cols = options.cols ?? DEFAULT_COLS;
	const rows = options.rows ?? DEFAULT_ROWS;

	const registry = createInstanceRegistry({
		createId: options.createId ?? (() => randomUUID()),
		start: ({ instanceId, kind, cwd }) =>
			createPtySession({
				instanceId,
				kind,
				cwd,
				cols,
				rows,
				spawn: (spawned) =>
					backend.spawnPty({ kind: spawned.kind, cwd: spawned.cwd, cols: spawned.cols, rows: spawned.rows }),
				screen: backend.createScreen({ cols, rows }),
				// 屏幕（xterm 画面）是权威表面；帧流当前不做二次保留，因此始终视为已消费。
				emit: () => true,
			}),
	});

	const server = createLocalApi({ registry, token, hostId });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("会话宿主监听地址异常");
	}

	const controlFile = options.controlFile ?? path.join(paths.runDir, "control.json");
	await mkdir(path.dirname(controlFile), { recursive: true });
	try {
		await writeControlFile(controlFile, { port: address.port, token, hostId });
	} catch (error) {
		// 控制文件写不出去就不能留下一个「跑着但没人能找到」的宿主。
		server.closeAllConnections();
		server.close();
		throw error;
	}

	// DSH 代理与宿主的本机接口分开监听：DSH 自己继续只监听回环。
	let dshProxy: http.Server | null = null;
	if (options.dshProxy !== undefined) {
		dshProxy = createDshProxy({ target: options.dshProxy.target, token });
		try {
			await new Promise<void>((resolve, reject) => {
				dshProxy?.once("error", reject);
				dshProxy?.listen(0, "127.0.0.1", resolve);
			});
		} catch (error) {
			dshProxy.closeAllConnections();
			dshProxy.close();
			server.closeAllConnections();
			server.close();
			throw error;
		}
	}
	const dshProxyAddress = dshProxy?.address();
	const dshProxyPort =
		dshProxyAddress !== null && typeof dshProxyAddress === "object" ? dshProxyAddress.port : null;

	let shuttingDown = false;
	async function shutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		for (const instance of registry.list()) {
			const record = registry.get(instance.instanceId);
			if (record !== undefined) await record.session.stop();
		}
		if (dshProxy !== null) {
			await new Promise<void>((resolve) => {
				dshProxy?.close(() => resolve());
				dshProxy?.closeAllConnections();
			});
		}
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
		await rm(controlFile, { force: true });
	}

	return { hostId, token, port: address.port, controlFile, registry, server, dshProxyPort, shutdown };
}

/**
 * 命令行入口。
 *
 * 启动命令来自 `SESSION_HOST_COMMANDS`（JSON：`{"pi":{"file":"...","args":[]}}`），
 * 由部署（安装脚本/守护定义）提供；缺失时明确失败，不猜测可执行文件。
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const raw = env.SESSION_HOST_COMMANDS;
	if (typeof raw !== "string" || raw.length === 0) {
		process.stderr.write("缺少 SESSION_HOST_COMMANDS 配置，宿主未启动\n");
		process.exitCode = 2;
		return;
	}
	let commands: Partial<Record<SessionHostKind, SessionHostCommand>>;
	try {
		commands = JSON.parse(raw) as Partial<Record<SessionHostKind, SessionHostCommand>>;
	} catch {
		process.stderr.write("SESSION_HOST_COMMANDS 不是合法 JSON，宿主未启动\n");
		process.exitCode = 2;
		return;
	}

	try {
		const runtime = await startSessionHost({ commands, controlFile: env.SESSION_HOST_CONTROL_FILE });
		const stop = (): void => {
			void runtime.shutdown().then(
				() => process.exit(0),
				() => process.exit(1),
			);
		};
		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
		// Windows 没有 SIGTERM，只能靠控制台关闭事件；SIGBREAK 是 Ctrl+Break。
		process.on("SIGBREAK", stop);
	} catch {
		// 启动失败只报固定消息：不回显路径、令牌或原始错误。
		process.stderr.write("会话宿主启动失败\n");
		process.exitCode = 1;
	}
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	void main();
}
