import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { stat, rm } from "node:fs/promises";
import path from "node:path";
import type { SessionHostKind } from "@vcpdeck/shared";

/**
 * 会话宿主监督（ADR-0046 第二次修订）：
 * 宿主由 Client 作为**子进程**启动，随 Client 生命周期结束。
 * Client 重启/更新导致宿主被杀是可接受的，但**不得伪装**——实例状态由对账链路如实上报。
 *
 * 本模块只负责「起得来、停得掉、不伪装就绪」，不持有任何令牌或正文，也不打印日志。
 */

/** 一个受管 kind 对应的本机启动命令（与宿主侧约定同形）。 */
export interface SupervisorCommand {
	file: string;
	args?: string[];
}

/** 文件系统缝隙（测试注入）。 */
export interface SessionHostSupervisorFs {
	/** 仅用于判断存在性：不存在时应抛错。 */
	stat(filePath: string): Promise<unknown>;
	rm(filePath: string): Promise<void>;
}

export interface SessionHostSupervisorOptions {
	/** 宿主入口脚本绝对路径。 */
	hostEntry: string;
	/** 控制文件绝对路径：由 Client 决定并同时告知宿主。 */
	controlFile: string;
	commands: Partial<Record<SessionHostKind, SupervisorCommand>>;
	env?: NodeJS.ProcessEnv;
	/** 就绪等待上限（默认 10s）。 */
	readyTimeoutMs?: number;
	/** 就绪轮询间隔（默认 50ms）。 */
	pollIntervalMs?: number;
	spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	fs?: SessionHostSupervisorFs;
}

export interface SessionHostSupervisor {
	/** 启动宿主并等待控制文件出现；未安装/超时/立即退出都返回 false（不抛、不伪装）。 */
	start(): Promise<boolean>;
	/** 终止宿主并清理控制文件；重复调用幂等。 */
	stop(): Promise<void>;
	readonly running: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

const realFs: SessionHostSupervisorFs = {
	stat: (filePath) => stat(filePath),
	rm: async (filePath) => {
		await rm(filePath, { force: true });
	},
};

/**
 * 由 Client 自身入口推导同级宿主入口。
 *
 * 发布布局：`<version>/client/dist/index.js` → `<version>/session-host/dist/server.js`；
 * dev 布局（`packages/client/dist/index.js`）同样成立。取不到 argv[1] 时返回 null，
 * 由调用方决定不启动，而不是猜路径。
 */
export function defaultHostEntry(argv1: string | undefined): string | null {
	if (typeof argv1 !== "string" || argv1.length === 0) return null;
	const clientDistDir = path.dirname(argv1);
	return path.resolve(clientDistDir, "..", "..", "session-host", "dist", "server.js");
}

/**
 * 控制文件默认路径。
 *
 * 必须与 `packages/session-host/src/paths.ts` 的 `runDir` 约定一致（宿主也是按同一约定写入）；
 * 两者是两个包的独立实现，改动时需同时修改（`scripts/session-host-layout.test.ts` 锁住宿主侧字面量）。
 */
export function defaultControlFile(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === "win32") {
		const base = env.ProgramData ?? env.ALLUSERSPROFILE;
		if (!base) throw new Error("无法确定会话宿主运行时目录：ProgramData 缺失");
		return path.win32.join(base, "VCPDeck", "session-host", "run", "control.json");
	}
	if (platform === "linux") return "/var/lib/vcpdeck/session-host/run/control.json";
	throw new Error(`会话宿主不支持该平台：${platform}`);
}

export function createSessionHostSupervisor(options: SessionHostSupervisorOptions): SessionHostSupervisor {
	const fs = options.fs ?? realFs;
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const spawnImpl = options.spawnImpl ?? spawn;

	let child: ChildProcess | null = null;
	let exitPromise: Promise<void> | null = null;
	let hasExited = false;

	function exists(filePath: string): Promise<boolean> {
		return fs.stat(filePath).then(
			() => true,
			() => false,
		);
	}

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function waitForReady(): Promise<boolean> {
		const deadline = Date.now() + readyTimeoutMs;
		for (;;) {
			if (await exists(options.controlFile)) return true;
			if (hasExited) return false;
			if (Date.now() >= deadline) return false;
			await delay(pollIntervalMs);
		}
	}

	return {
		get running() {
			return child !== null && !hasExited;
		},

		async start() {
			if (child !== null && !hasExited) return true;
			if (!(await exists(options.hostEntry))) {
				// 宿主未安装（旧版本或未打包）不是启动失败，交由对账链路如实显示「不可达」。
				return false;
			}

			// 残留控制文件必须先生效前清掉：否则会把上一具尸体的端口当成就绪。
			await fs.rm(options.controlFile);

			child = spawnImpl(process.execPath, [options.hostEntry], {
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
				// 必须继承父进程环境：只给两个变量会让子进程丢掉 PATH/SystemRoot/TEMP 等
				// Windows 必需变量，宿主会在启动阶段失败（本轮 dev 集成实测：静默失败）。
				env: {
					...process.env,
					...(options.env ?? {}),
					SESSION_HOST_COMMANDS: JSON.stringify(options.commands),
					SESSION_HOST_CONTROL_FILE: options.controlFile,
				},
			});
			hasExited = false;
			exitPromise = new Promise<void>((resolve) => {
				child?.once("exit", () => {
					hasExited = true;
					resolve();
				});
			});
			child.on("error", () => {
				hasExited = true;
			});

			if (await waitForReady()) return true;

			// 没就绪就当真：不 return true 冒充成功，并把子进程收掉。
			await this.stop();
			return false;
		},

		async stop() {
			const target = child;
			if (target === null) {
				await fs.rm(options.controlFile).catch(() => {});
				return;
			}
			if (!hasExited) {
				try {
					target.kill();
				} catch {
					// 已经退出或无法终止：下面按有界等待处理。
				}
				const waiting = exitPromise ?? Promise.resolve();
				await Promise.race([waiting, delay(DEFAULT_STOP_TIMEOUT_MS)]);
			}
			await fs.rm(options.controlFile).catch(() => {});
			child = null;
			exitPromise = null;
		},
	};
}
