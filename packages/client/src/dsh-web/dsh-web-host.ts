import { execFile } from "node:child_process";
import { connect } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { resolveSpawnTarget } from "../acp/windows-launcher.js";

const execFileAsync = promisify(execFile);

/** 启动 `dsh web` 的选项。 */
export interface DshWebStartOptions {
	/** 监听端口（loopback）。 */
	port: number;
	/** `dsh` 命令名或路径，默认 `dsh`。 */
	command?: string;
	/** 捕获到 token 的超时，默认 20s。 */
	timeoutMs?: number;
}

/** 启动结果：仅含一次性 token 与端口，不含完整 URL。 */
export interface DshWebStarted {
	port: number;
	token: string;
}

export interface DshWebHost {
	start(options: DshWebStartOptions): Promise<DshWebStarted>;
	/**
	 * 停止受管实例。
	 *
	 * 优先杀持有的子进程；随后**按端口兜底清理**——Client 重启（`tsx watch`、
	 * 升级、崩溃重启）会丢掉子进程句柄，此时只有端口是仍然可靠的事实。
	 */
	stop(port?: number): Promise<void>;
	/** 当前是否在运行。 */
	running(): boolean;
}

export interface DshWebHostDeps {
	/** 测试注入：替换真实 spawn。 */
	spawnImpl?: typeof spawn;
	/** 测试注入：替换端口兜底清理。 */
	killByPortImpl?: (port: number) => Promise<void>;
	/** 测试注入：替换端口占用探测。 */
	isPortListeningImpl?: (port: number) => Promise<boolean>;
	/** 停止后等待端口释放的时长，默认 3s。 */
	stopVerifyTimeoutMs?: number;
}

interface Runtime {
	child: ChildProcess;
	port: number;
}

function hostError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * 从 `dsh web` 的输出里取一次性 token。
 *
 * 真实输出形如 `dsh web: http://127.0.0.1:30999/?token=<...>`；这里只认带 token
 * 的 URL，避免把普通日志行误判成就绪信号。
 */
export function extractToken(line: string): string | null {
	const match = /https?:\/\/[^\s]*[?&]token=([A-Za-z0-9_-]{8,})/.exec(line);
	return match?.[1] ?? null;
}

/**
 * 从 `netstat -ano` 输出里解析监听指定端口的 PID。
 *
 * 行形如 `  TCP    127.0.0.1:33919    0.0.0.0:0    LISTENING    9832`。
 */
export function parseListeningPids(output: string, port: number): number[] {
	const pids = new Set<number>();
	for (const line of output.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 5) continue;
		if (!/^(TCP|TCPv6)$/i.test(cols[0] ?? "")) continue;
		if ((cols[3] ?? "").toUpperCase() !== "LISTENING") continue;
		const local = cols[1] ?? "";
		const localPort = Number(local.slice(local.lastIndexOf(":") + 1));
		const pid = Number(cols[4]);
		if (localPort === port && Number.isInteger(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}

/** 解析 `lsof -ti tcp:<port>` 的输出（PID 列表，一行一个）。 */
export function parseLsofPids(output: string): number[] {
	return output
		.split(/\r?\n/)
		.map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function runCapture(command: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(command, args, {
		windowsHide: true,
		timeout: 10_000,
		maxBuffer: 4 * 1024 * 1024,
	});
	return stdout;
}

function runQuiet(command: string, args: string[]): Promise<void> {
	return new Promise<void>((resolve) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			windowsHide: true,
		});
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
}

/**
 * 杀掉监听指定端口的进程（尽力而为）。
 *
 * Windows 用 `netstat -ano` 找 PID 再 `taskkill /T /F` 连子进程一起收；
 * 其他平台用 `lsof`。任何一步失败都静默返回——清理是尽力而为，不能阻塞停止流程。
 */
export async function killListeningProcess(port: number): Promise<void> {
	if (process.platform === "win32") {
		const out = await runCapture("netstat", ["-ano", "-p", "tcp"]).catch(
			() => "",
		);
		for (const pid of parseListeningPids(out, port)) {
			await runQuiet("taskkill", ["/PID", String(pid), "/T", "/F"]);
		}
		return;
	}
	const out = await runCapture("lsof", ["-ti", `tcp:${port}`]).catch(() => "");
	for (const pid of parseLsofPids(out)) {
		await runQuiet("kill", ["-9", String(pid)]);
	}
}

/** 探测端口是否仍有人监听（loopback）。 */
export function isPortListening(port: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		let done = false;
		const settle = (value: boolean) => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(1_000);
		socket.once("connect", () => settle(true));
		socket.once("timeout", () => settle(false));
		socket.once("error", () => settle(false));
	});
}

/** 构造受管的 `dsh web` 进程控制器（同一时刻只允许一个实例）。 */
export function createDshWebHost(deps: DshWebHostDeps = {}): DshWebHost {
	const spawnImpl = deps.spawnImpl ?? spawn;
	const killByPort = deps.killByPortImpl ?? killListeningProcess;
	const probe = deps.isPortListeningImpl ?? isPortListening;
	let runtime: Runtime | null = null;

	/** 轮询等待端口释放；`taskkill` 返回时端口可能还没完全释放。 */
	async function waitPortFree(port: number): Promise<boolean> {
		const timeoutMs = deps.stopVerifyTimeoutMs ?? 3_000;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (!(await probe(port).catch(() => false))) return true;
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	}

	async function start(options: DshWebStartOptions): Promise<DshWebStarted> {
		if (runtime) {
			throw hostError("DSH_WEB_ALREADY_RUNNING", "dsh web 已在运行");
		}
		const target = resolveSpawnTarget({
			command: options.command ?? "dsh",
			args: [
				"--profile",
				"web",
				"--host",
				"127.0.0.1",
				"--port",
				String(options.port),
				"--no-open",
			],
		});
		const child = spawnImpl(target.command, target.args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			...(target.windowsVerbatimArguments
				? { windowsVerbatimArguments: true }
				: {}),
		});

		const started = new Promise<DshWebStarted>((resolve, reject) => {
			const timer = setTimeout(() => {
				finish();
				child.kill();
				reject(
					hostError("DSH_WEB_START_TIMEOUT", "等待 dsh web 就绪超时"),
				);
			}, options.timeoutMs ?? 20_000);
			let settled = false;
			const finish = () => {
				if (settled) return false;
				settled = true;
				clearTimeout(timer);
				return true;
			};
			const onChunk = (chunk: Buffer) => {
				const token = extractToken(chunk.toString("utf8"));
				if (!token) return;
				if (!finish()) return;
				runtime = { child, port: options.port };
				resolve({ port: options.port, token });
			};
			child.stdout?.on("data", onChunk);
			child.stderr?.on("data", onChunk);
			child.once("error", (cause) => {
				if (!finish()) return;
				runtime = null;
				reject(
					hostError(
						"DSH_WEB_START_FAILED",
						cause instanceof Error ? cause.message : "dsh web 启动失败",
					),
				);
			});
			child.once("exit", (code) => {
				runtime = null;
				if (!finish()) return;
				reject(
					hostError(
						"DSH_WEB_START_FAILED",
						`dsh web 在就绪前退出（code=${code ?? "null"}）`,
					),
				);
			});
		});

		return started;
	}

	async function stop(port?: number): Promise<void> {
		const current = runtime;
		runtime = null;
		const targetPort = port ?? current?.port;
		if (current) {
			const exited = new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 2_000);
				current.child.once("exit", () => {
					clearTimeout(timer);
					resolve(true);
				});
			});
			current.child.kill();
			await exited;
		}
		// 句柄可能已失效（Client 重启）或子进程逃逸出包装器：以端口为准收尾。
		if (targetPort) {
			await killByPort(targetPort).catch(() => undefined);
			// 清理失败要说出来：静默留一个仍在监听的 dsh web 比报错更糟。
			// taskkill 返回后端口释放还有短暂延迟，所以要轮询而不是立刻判定。
			if (!(await waitPortFree(targetPort))) {
				throw hostError(
					"DSH_WEB_STOP_INCOMPLETE",
					`端口 ${targetPort} 仍在监听，dsh web 未能退出`,
				);
			}
		}
	}

	return {
		start,
		stop,
		running: () => runtime !== null,
	};
}
