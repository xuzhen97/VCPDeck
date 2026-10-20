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

/**
 * 从 `/proc/net/tcp`（或 `tcp6`）里解析出监听指定端口的 socket inode。
 *
 * 行形如：
 * `   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 ... 12345 1 ...`
 * - 第二列 `local_address` 是 `HEXIP:HEXPORT`（IPv4 小端序）；
 * - 第四列 `st` 为 `0A` 表示 LISTEN；
 * - inode 位于第 10 列。
 *
 * 之所以不走 `lsof`：它是可选包，多数精简 Linux 发行版默认不装，
 * 而 `/proc` 是内核自带的，零依赖。
 */
export function parseProcNetTcpListeners(
	content: string,
	port: number,
): number[] {
	const inodes = new Set<number>();
	for (const line of content.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 10) continue;
		// 表头或非法行
		if (!/^\d+:$/.test(cols[0] ?? "")) continue;
		if ((cols[3] ?? "").toUpperCase() !== "0A") continue;
		const local = cols[1] ?? "";
		const portHex = local.slice(local.lastIndexOf(":") + 1);
		if (Number.parseInt(portHex, 16) !== port) continue;
		const inode = Number(cols[9]);
		if (Number.isInteger(inode) && inode > 0) inodes.add(inode);
	}
	return [...inodes];
}

/** `/proc` 读取依赖注入点；测试用来喂假文件系统。 */
export interface ProcFsDeps {
	readFile?: (path: string) => Promise<string>;
	readdir?: (path: string) => Promise<string[]>;
	readlink?: (path: string) => Promise<string>;
}

async function defaultReadFile(path: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(path, "utf8");
}

async function defaultReaddir(path: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	return readdir(path);
}

async function defaultReadlink(path: string): Promise<string> {
	const { readlink } = await import("node:fs/promises");
	return readlink(path);
}

/**
 * 在 Linux 上找出监听指定端口的进程（纯 `/proc`，不依赖 lsof）。
 *
 * 步骤：`/proc/net/tcp{,6}` 拿到 socket inode → 扫 `/proc/<pid>/fd/*`
 * 的符号链接（形如 `socket:[12345]`）匹配 inode → 得到 PID。
 * 无权限读取的进程会被跳过（尽力而为）。
 */
export async function findListeningPidsViaProc(
	port: number,
	deps: ProcFsDeps = {},
): Promise<number[]> {
	const readFile = deps.readFile ?? defaultReadFile;
	const readdir = deps.readdir ?? defaultReaddir;
	const readlink = deps.readlink ?? defaultReadlink;

	const contents = await Promise.all(
		["/proc/net/tcp", "/proc/net/tcp6"].map((path) =>
			readFile(path).catch(() => ""),
		),
	);
	const inodes = new Set<number>();
	for (const content of contents) {
		for (const inode of parseProcNetTcpListeners(content, port)) {
			inodes.add(inode);
		}
	}
	if (inodes.size === 0) return [];

	let entries: string[];
	try {
		entries = await readdir("/proc");
	} catch {
		return [];
	}

	const pids = new Set<number>();
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid <= 0) continue;
		let fds: string[];
		try {
			fds = await readdir(`/proc/${entry}/fd`);
		} catch {
			continue; // 权限不足或进程已退出
		}
		for (const fd of fds) {
			let target: string;
			try {
				target = await readlink(`/proc/${entry}/fd/${fd}`);
			} catch {
				continue;
			}
			const match = /^socket:\[(\d+)\]$/.exec(target);
			if (!match) continue;
			if (inodes.has(Number(match[1]))) {
				pids.add(pid);
				break;
			}
		}
	}
	return [...pids];
}

/**
 * 判断某 PID 是不是我们起的 `dsh web`。
 *
 * 返回 `null` 表示读不到命令行（权限等），调用方应按"可能是"处理——
 * 宁可多清一次，也不要留下无法回收的进程。
 */
export async function isDshWebProcess(
	pid: number,
	deps: ProcFsDeps = {},
): Promise<boolean | null> {
	const readFile = deps.readFile ?? defaultReadFile;
	try {
		const raw = await readFile(`/proc/${pid}/cmdline`);
		const cmdline = raw.replace(/\0/g, " ").trim();
		if (cmdline.length === 0) return null;
		return cmdline.includes("--profile") && /\bweb\b/.test(cmdline);
	} catch {
		return null;
	}
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
 * Linux 走 `/proc`（零依赖），读不到再退到 `lsof`；两者都失败就静默放弃——
 * 清理是尽力而为，不能阻塞停止流程。
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

	let pids = await findListeningPidsViaProc(port).catch(() => [] as number[]);
	if (pids.length === 0) {
		// 容器里可能没有 /proc/net，退回 lsof（装了才有）。
		const out = await runCapture("lsof", ["-ti", `tcp:${port}`]).catch(
			() => "",
		);
		pids = parseLsofPids(out);
	}
	for (const pid of pids) {
		// 只杀确实是 dsh web 的进程：端口可能已被别的程序复用。
		// 读不到命令行时按"可能是"处理，避免留下无法回收的进程。
		const ours = await isDshWebProcess(pid).catch(() => null);
		if (ours === false) continue;
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
