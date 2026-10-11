import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	type SessionHostSupervisorFs,
	createSessionHostSupervisor,
	defaultControlFile,
	defaultHostEntry,
} from "./supervisor.js";

const ENTRY = "D:/v/0.18.2/session-host/dist/server.js";
const CONTROL = "D:/run/control.json";
const COMMANDS = { pi: { file: "pi", args: [] } };

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		kill: (signal?: string) => boolean;
		killed: boolean;
		pid: number;
	};
	child.killed = false;
	child.pid = 4242;
	child.kill = () => {
		child.killed = true;
		// 真实进程被终止后会退出：异步触发，避免把同步 emit 当成实现依赖。
		queueMicrotask(() => child.emit("exit", 0));
		return true;
	};
	return child;
}

function harness(options: { ready?: boolean; entryExists?: boolean; exitOnSpawn?: boolean } = {}) {
	const spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
	const children: Array<ReturnType<typeof fakeChild>> = [];
	const removed: string[] = [];
	const order: string[] = [];
	const ready = options.ready ?? true;
	const entryExists = options.entryExists ?? true;

	const fs: SessionHostSupervisorFs = {
		stat: async (file: string) => {
			if (file === ENTRY && !entryExists) throw new Error("ENOENT");
			if (file === CONTROL && !ready) throw new Error("ENOENT");
			return undefined;
		},
		rm: async (file: string) => {
			removed.push(file);
			order.push(`remove:${file}`);
		},
	};

	const supervisor = createSessionHostSupervisor({
		hostEntry: ENTRY,
		controlFile: CONTROL,
		commands: COMMANDS,
		readyTimeoutMs: 60,
		pollIntervalMs: 5,
		fs,
		spawnImpl: (command, args, spawnOptions) => {
			order.push(`spawn:${command}`);
			spawnCalls.push({ command, args, options: spawnOptions });
			const child = fakeChild();
			children.push(child);
			if (options.exitOnSpawn === true) queueMicrotask(() => child.emit("exit", 1));
			return child as unknown as ChildProcess;
		},
	});

	return { supervisor, spawnCalls, children, removed, order };
}

describe("宿主入口与运行时路径推导", () => {
	it("从 Client 入口推导同级 session-host 入口", () => {
		expect(defaultHostEntry("D:/v/0.18.2/client/dist/index.js")?.replace(/\\/g, "/")).toBe(ENTRY);
	});

	it("缺少 argv[1] 时不猜路径", () => {
		expect(defaultHostEntry(undefined)).toBeNull();
	});

	it("控制文件默认路径与宿主自身约定一致，且不由版本号派生", () => {
		expect(defaultControlFile("win32", { ProgramData: "C:\\ProgramData" })).toBe(
			"C:\\ProgramData\\VCPDeck\\session-host\\run\\control.json",
		);
		expect(defaultControlFile("linux", {})).toBe("/var/lib/vcpdeck/session-host/run/control.json");
		expect(() => defaultControlFile("darwin", {})).toThrow();
	});
});

describe("宿主监督：启动", () => {
	it("宿主未安装时返回 false 且不启动任何进程", async () => {
		const h = harness({ entryExists: false });
		expect(await h.supervisor.start()).toBe(false);
		expect(h.spawnCalls).toHaveLength(0);
	});

	it("先把残留控制文件清掉再启动，避免把上一具尸体当就绪", async () => {
		const h = harness();
		await h.supervisor.start();
		expect(h.removed).toContain(CONTROL);
		expect(h.order.indexOf(`remove:${CONTROL}`)).toBeLessThan(
			h.order.findIndex((item) => item.startsWith("spawn:")),
		);
	});

	it("以当前 Node 启动宿主入口并传入启动命令", async () => {
		const h = harness();
		expect(await h.supervisor.start()).toBe(true);
		expect(h.spawnCalls).toHaveLength(1);
		expect(h.spawnCalls[0]?.args).toEqual([ENTRY]);
		expect(JSON.parse(String(h.spawnCalls[0]?.options.env?.SESSION_HOST_COMMANDS))).toEqual(COMMANDS);
	});

	it("子进程必须继承父进程环境：只给两个变量会让宿主静默启动失败", async () => {
		const h = harness();
		await h.supervisor.start();
		const env = h.spawnCalls[0]?.options.env as Record<string, string> | undefined;
		expect(env).toBeDefined();
		// 不只看我们追加的两个变量：PATH/SystemRoot 等父进程环境必须在场，
		// 否则 Windows 下宿主会在启动阶段失败，而 stdio=ignore 会把它吞成完全静默。
		expect(Object.keys(env ?? {}).length).toBeGreaterThan(2);
		expect(env?.PATH ?? env?.Path).toBeDefined();
		expect(env?.SESSION_HOST_COMMANDS).toContain("pi");
		expect(env?.SESSION_HOST_CONTROL_FILE).toBe(CONTROL);
	});

	it("控制文件未出现且子进程立刻退出时返回 false，不伪装就绪", async () => {
		const h = harness({ ready: false, exitOnSpawn: true });
		expect(await h.supervisor.start()).toBe(false);
	});

	it("就绪超时时返回 false 并终止子进程", async () => {
		const h = harness({ ready: false });
		expect(await h.supervisor.start()).toBe(false);
		expect(h.children[0]?.killed).toBe(true);
	});

	it("重复 start 不重复启动", async () => {
		const h = harness();
		expect(await h.supervisor.start()).toBe(true);
		expect(await h.supervisor.start()).toBe(true);
		expect(h.spawnCalls).toHaveLength(1);
	});
});

describe("宿主监督：停止", () => {
	it("停止时终止子进程并删除控制文件", async () => {
		const h = harness();
		await h.supervisor.start();
		const child = h.children[0];
		const stopping = h.supervisor.stop();
		child?.emit("exit", 0);
		await stopping;
		expect(child?.killed).toBe(true);
		expect(h.removed).toContain(CONTROL);
	});

	it("重复停止是幂等的", async () => {
		const h = harness();
		await h.supervisor.start();
		const stopping = h.supervisor.stop();
		h.children[0]?.emit("exit", 0);
		await stopping;
		await h.supervisor.stop();
		expect(h.spawnCalls).toHaveLength(1);
	});
});

describe("宿主监督：泄露边界", () => {
	it("不打印任何日志（令牌与正文都不得进日志）", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const h = harness({ entryExists: false });
			await h.supervisor.start();
			await h.supervisor.stop();
			expect(log).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			error.mockRestore();
			warn.mockRestore();
		}
	});
});
