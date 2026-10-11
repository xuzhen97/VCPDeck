import { describe, expect, it } from "vitest";
import {
	type NativeBackendStatus,
	type NativeModuleSet,
	type NativeTerminalLike,
	buildWorkerEnv,
	createNativeBackend,
	probeNativeBackend,
} from "./native-pty.js";
import type { PtyProcessHandle } from "./pty-session.js";

function fakeHandle(): PtyProcessHandle {
	return {
		onData() {},
		onExit() {},
		write() {},
		resize() {},
		kill() {},
	};
}

/** 假 xterm：记录写入与尺寸，serialize 返回拼接内容。 */
class FakeTerminal implements NativeTerminalLike {
	cols: number;
	rows: number;
	readonly chunks: string[] = [];
	private addons: unknown[] = [];
	disposed = false;
	constructor(options: { cols: number; rows: number }) {
		this.cols = options.cols;
		this.rows = options.rows;
	}
	loadAddon(addon: unknown) {
		this.addons.push(addon);
	}
	write(data: string, callback?: () => void) {
		this.chunks.push(data);
		callback?.();
	}
	resize(cols: number, rows: number) {
		this.cols = cols;
		this.rows = rows;
	}
	dispose() {
		this.disposed = true;
	}
	get addonCount() {
		return this.addons.length;
	}
}

class FakeSerializeAddon {
	constructor() {
		FakeSerializeAddon.instances += 1;
	}
	serialize() {
		return "serialized";
	}
	static instances = 0;
}

function fakeModules(spawnImpl?: (file: string, args: string[], options: Record<string, unknown>) => PtyProcessHandle) {
	const spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
	const modules: NativeModuleSet = {
		pty: {
			spawn(file, args, options) {
				spawnCalls.push({ file, args, options: options as unknown as Record<string, unknown> });
				return (spawnImpl ?? (() => fakeHandle()))(file, args, options as unknown as Record<string, unknown>);
			},
		},
		headless: { Terminal: FakeTerminal as unknown as NativeModuleSet["headless"]["Terminal"] },
		serialize: { SerializeAddon: FakeSerializeAddon },
	};
	return { modules, spawnCalls };
}

const COMMANDS = { pi: { file: "pi", args: ["--tui"] }, dsh: { file: "dsh", args: [] } };

describe("原生后端探测", () => {
	it("依赖缺失时明确不可用，且错误消息不含路径或堆栈", async () => {
		const status: NativeBackendStatus = await probeNativeBackend({
			load: async () => {
				throw new Error("Cannot find module 'D:/secret/path/node-pty'");
			},
		});
		expect(status.available).toBe(false);
		expect(status.code).toBe("SESSION_HOST_NATIVE_BACKEND_UNAVAILABLE");
		expect(status.message).not.toContain("secret");
		expect(status.message).not.toContain("D:/");
	});

	it("模块形状不对时同样判为不可用", async () => {
		const status = await probeNativeBackend({
			load: async () => ({ pty: {}, headless: {}, serialize: {} }) as unknown as NativeModuleSet,
		});
		expect(status.available).toBe(false);
	});

	it("三个模块齐备时可用", async () => {
		const { modules } = fakeModules();
		const status = await probeNativeBackend({ load: async () => modules });
		expect(status).toEqual({ available: true });
	});
});

describe("原生后端装配", () => {
	it("未配置该 kind 的启动命令时明确失败，不猜测命令", async () => {
		const { modules } = fakeModules();
		const backend = await createNativeBackend({ modules, commands: { pi: COMMANDS.pi } });
		expect(() => backend.spawnPty({ kind: "dsh", cwd: "/w", cols: 80, rows: 24 })).toThrow();
	});

	it("工作进程环境只保留 allowlist 并设置 TERM", () => {
		const env = buildWorkerEnv({
			PATH: "/usr/bin",
			SystemRoot: "C:/Windows",
			SECRET_TOKEN: "leak-me",
			AWS_SECRET_ACCESS_KEY: "leak-me-too",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.SystemRoot).toBe("C:/Windows");
		expect(env.TERM).toBe("xterm-256color");
		expect(env.SECRET_TOKEN).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
	});

	it("Windows 先试 useConptyDll，失败后回退默认路径", async () => {
		let attempt = 0;
		const { modules, spawnCalls } = fakeModules((_file, _args, options) => {
			attempt += 1;
			if (options.useConptyDll === true) throw new Error("conpty dll 不可用");
			return fakeHandle();
		});
		const backend = await createNativeBackend({ modules, commands: COMMANDS, platform: "win32" });
		backend.spawnPty({ kind: "pi", cwd: "/w", cols: 100, rows: 30 });
		expect(attempt).toBe(2);
		expect(spawnCalls[0]?.options.useConptyDll).toBe(true);
		expect(spawnCalls[1]?.options.useConptyDll).toBeUndefined();
		expect(spawnCalls[1]?.options.cols).toBe(100);
		expect(spawnCalls[1]?.options.rows).toBe(30);
		expect(spawnCalls[1]?.args).toEqual(["--tui"]);
	});

	it("非 Windows 只调用一次且不设置 conpty 选项", async () => {
		const { modules, spawnCalls } = fakeModules();
		const backend = await createNativeBackend({ modules, commands: COMMANDS, platform: "linux" });
		backend.spawnPty({ kind: "pi", cwd: "/w", cols: 80, rows: 24 });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.options.useConptyDll).toBeUndefined();
		expect(spawnCalls[0]?.options.name).toBe("xterm-256color");
		expect(spawnCalls[0]?.options.cwd).toBe("/w");
	});

	it("画面接到真实 Terminal 与 SerializeAddon", async () => {
		const { modules } = fakeModules();
		const backend = await createNativeBackend({ modules, commands: COMMANDS, platform: "linux" });
		const screen = backend.createScreen({ cols: 120, rows: 30 });
		expect(screen.cols).toBe(120);
		expect(screen.rows).toBe(30);
		screen.write("hello", () => {});
		expect(screen.serialize()).toBe("serialized");
		screen.resize(90, 20);
		expect(screen.cols).toBe(90);
		expect(screen.rows).toBe(20);
		screen.dispose();
		expect(FakeSerializeAddon.instances).toBeGreaterThan(0);
	});
});
