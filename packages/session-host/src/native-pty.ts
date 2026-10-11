import type { SessionHostKind } from "@vcpdeck/shared";
import type { PtyProcessHandle, PtyScreen } from "./pty-session.js";

/**
 * 原生后端（真实 PTY + 终端模拟器）装配。
 *
 * 三个 native 依赖全部延迟加载：缺失时只禁用会话宿主能力，
 * 不能让宿主进程或 Client 的其它能力一起崩掉。
 */

/** node-pty 兼容的最小句柄形状。 */
export interface NativePtyModule {
	spawn(file: string, args: string[], options: NativeSpawnOptions): PtyProcessHandle;
}

export interface NativeSpawnOptions {
	name: string;
	cols: number;
	rows: number;
	cwd: string;
	env: Record<string, string>;
	useConptyDll?: boolean;
}

/** xterm headless Terminal 兼容形状。 */
export interface NativeTerminalLike {
	write(data: string, callback?: () => void): void;
	resize(cols: number, rows: number): void;
	dispose(): void;
	loadAddon(addon: unknown): void;
	readonly cols: number;
	readonly rows: number;
}

export interface NativeHeadlessModule {
	Terminal: new (options: {
		cols: number;
		rows: number;
		scrollback: number;
		allowProposedApi: boolean;
	}) => NativeTerminalLike;
}

export interface NativeSerializeModule {
	SerializeAddon: new () => { serialize(): string };
}

export interface NativeModuleSet {
	pty: NativePtyModule;
	headless: NativeHeadlessModule;
	serialize: NativeSerializeModule;
}

export interface NativeBackendStatus {
	available: boolean;
	code?: "SESSION_HOST_NATIVE_BACKEND_UNAVAILABLE";
	message?: string;
}

export type NativeModuleLoader = () => Promise<NativeModuleSet>;

/** 工作进程只拿到本机运行必需的环境变量，绝不继承宿主的环境（可能含凭据）。 */
const ENV_ALLOWLIST = [
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"HOME",
	"USERPROFILE",
	"TEMP",
	"TMP",
	"LANG",
] as const;

const DEFAULT_SCROLLBACK = 2000;

/** 一个受管 kind 对应的本机启动命令。由部署提供，宿主不猜测。 */
export interface SessionHostCommand {
	file: string;
	args?: string[];
}

export interface NativeBackendOptions {
	/** 注入原生模块（测试用）；缺省时动态加载。 */
	modules?: NativeModuleSet;
	/** 每种环境类型的启动命令；缺失的 kind 明确失败而不是猜测。 */
	commands: Partial<Record<SessionHostKind, SessionHostCommand>>;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	scrollback?: number;
}

export interface NativeBackend {
	spawnPty: (options: { kind: SessionHostKind; cwd: string; cols: number; rows: number }) => PtyProcessHandle;
	createScreen: (options: { cols: number; rows: number }) => PtyScreen;
}

/** 构造工作进程环境：只保留 allowlist，并显式设置 TERM。 */
export function buildWorkerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ENV_ALLOWLIST) {
		const value = source[key];
		if (typeof value === "string") env[key] = value;
	}
	env.TERM = "xterm-256color";
	return env;
}

/** 严格形状校验：拿到的模块必须真的能用，否则视为不可用。 */
export function isNativeModuleSet(value: unknown): value is NativeModuleSet {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const pty = candidate.pty as Record<string, unknown> | undefined;
	const headless = candidate.headless as Record<string, unknown> | undefined;
	const serialize = candidate.serialize as Record<string, unknown> | undefined;
	return (
		typeof pty?.spawn === "function" &&
		typeof headless?.Terminal === "function" &&
		typeof serialize?.SerializeAddon === "function"
	);
}

/**
 * 取 CJS/ESM 互操作后的真实导出。
 *
 * 三个 native 依赖都是 CJS：有的把导出挂在命名空间上，有的只在 `default` 上，
 * 因此不能假设 `import()` 的形状，必须按目标符号存在与否选取。
 */
function pickExport<T>(mod: unknown, key: string): T {
	const direct = mod as Record<string, unknown> | null | undefined;
	if (direct && typeof direct[key] === "function") return mod as T;
	const fallback = direct?.default as Record<string, unknown> | undefined;
	if (fallback && typeof fallback[key] === "function") return fallback as T;
	throw new Error(`原生模块缺少 ${key} 导出`);
}

/** 默认加载器：动态 import 三个 native 依赖。 */
export function createDefaultNativeModuleLoader(): NativeModuleLoader {
	return async () => {
		const [pty, headless, serialize] = await Promise.all([
			import("@lydell/node-pty"),
			import("@xterm/headless"),
			import("@xterm/addon-serialize"),
		]);
		return {
			pty: pickExport<NativePtyModule>(pty, "spawn"),
			headless: pickExport<NativeHeadlessModule>(headless, "Terminal"),
			serialize: pickExport<NativeSerializeModule>(serialize, "SerializeAddon"),
		};
	};
}

/**
 * 探测原生后端可用性。
 *
 * 探测失败只返回不可用，错误消息固定且不含本地路径或堆栈。
 */
export async function probeNativeBackend(
	options: { load?: NativeModuleLoader } = {},
): Promise<NativeBackendStatus> {
	const load = options.load ?? createDefaultNativeModuleLoader();
	try {
		const modules = await load();
		if (!isNativeModuleSet(modules)) {
			return {
				available: false,
				code: "SESSION_HOST_NATIVE_BACKEND_UNAVAILABLE",
				message: "会话宿主原生后端不可用",
			};
		}
		return { available: true };
	} catch {
		return {
			available: false,
			code: "SESSION_HOST_NATIVE_BACKEND_UNAVAILABLE",
			message: "会话宿主原生后端不可用",
		};
	}
}

/**
 * 装配原生后端。
 *
 * Windows 先试 `useConptyDll`，抛错则回退默认路径：这条回退是实验阶段锁定的行为。
 */
export async function createNativeBackend(options: NativeBackendOptions): Promise<NativeBackend> {
	const modules = options.modules ?? (await createDefaultNativeModuleLoader()());
	if (!isNativeModuleSet(modules)) {
		throw new Error("会话宿主原生后端不可用");
	}
	const env = buildWorkerEnv(options.env);
	const platform = options.platform ?? process.platform;
	const scrollback = options.scrollback ?? DEFAULT_SCROLLBACK;

	function spawnPty(spawnOptions: {
		kind: SessionHostKind;
		cwd: string;
		cols: number;
		rows: number;
	}): PtyProcessHandle {
		const command = options.commands[spawnOptions.kind];
		if (command === undefined) {
			throw new Error(`未配置 ${spawnOptions.kind} 环境的启动命令`);
		}
		const ptyOptions: NativeSpawnOptions = {
			name: "xterm-256color",
			cols: spawnOptions.cols,
			rows: spawnOptions.rows,
			cwd: spawnOptions.cwd,
			env,
		};
		const args = command.args ?? [];
		if (platform === "win32") {
			try {
				return modules.pty.spawn(command.file, args, { ...ptyOptions, useConptyDll: true });
			} catch {
				return modules.pty.spawn(command.file, args, ptyOptions);
			}
		}
		return modules.pty.spawn(command.file, args, ptyOptions);
	}

	function createScreen(screenOptions: { cols: number; rows: number }): PtyScreen {
		const terminal = new modules.headless.Terminal({
			cols: screenOptions.cols,
			rows: screenOptions.rows,
			scrollback,
			allowProposedApi: true,
		});
		const serializer = new modules.serialize.SerializeAddon();
		terminal.loadAddon(serializer);
		return {
			get cols() {
				return terminal.cols;
			},
			get rows() {
				return terminal.rows;
			},
			write(data: string, done?: () => void) {
				terminal.write(data, done);
			},
			resize(cols: number, rows: number) {
				terminal.resize(cols, rows);
			},
			serialize() {
				return serializer.serialize();
			},
			dispose() {
				terminal.dispose();
			},
		};
	}

	return { spawnPty, createScreen };
}
