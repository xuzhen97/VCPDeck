import { io, type Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
	MachineRegister,
	PiCapabilityStatus,
	PiEvent,
	PiStateAck,
	StatusReport,
	TerminalCapabilityStatus,
} from "@vcpdeck/shared";
import { parsePiRequest } from "@vcpdeck/shared";
import { CLIENT_ID, getRegisterInfo } from "./register.js";
import { getHeartbeat } from "./heartbeat.js";
import { killJob, getRunningJobIds, getStatusReport } from "./executor.js";
import { dispatch } from "./dispatcher.js";
import {
	createPiSupervisor,
	type PiSupervisor,
	type PiWorkerHandle,
} from "./pi/supervisor.js";
import type { PiWorkerRequestMessage } from "./pi/worker-protocol.js";
import { probePiCapability } from "./pi/capability.js";
import { probeTerminalCapability } from "./terminal/capability.js";
import { discoverShells, type ShellDiscoveryEnv } from "./terminal/shell-discovery.js";
import { createTerminalManager, type PtyAdapter, type PtySpawnOptions } from "./terminal/terminal-manager.js";
import { attachTerminalBridge, wireManagerToSocket } from "./terminal/protocol-bridge.js";
import { killProcessTree } from "./terminal/process-tree.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fork } from "node:child_process";
import { join } from "node:path";

const SERVER_URL =
	(process.env.VCPDECK_SERVER || "http://localhost:3001") + "/client";
const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";

function main() {
	connect();
}

// Auto-run when executed directly: node dist/index.js
if (require.main === module) {
	main();
}

/** 真实 fork 项目 Worker（cwd 通过 argv 传入） */
function forkProjectWorker(cwd: string): PiWorkerHandle {
	const child = fork(join(__dirname, "pi", "worker.js"), [cwd], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	return {
		send: (msg: PiWorkerRequestMessage) => child.send(msg),
		onMessage: (listener) => {
			child.on("message", listener);
			return () => child.removeListener("message", listener);
		},
		onExit: (listener) => {
			child.on("exit", (code) => listener(code ?? 0));
			return () => child.removeListener("exit", listener);
		},
		kill: () => child.kill(),
	};
}

export interface PiBridgeDeps {
	clientId: string;
	supervisor: PiSupervisor;
	getPiStatus: () => Promise<PiCapabilityStatus>;
	getTerminalStatus: () => Promise<TerminalCapabilityStatus>;
	getRegister: (
		piStatus: PiCapabilityStatus | undefined,
		terminalStatus: TerminalCapabilityStatus | undefined,
	) => MachineRegister;
	getStatusReport: () => StatusReport;
}

export interface PiBridge {
	/** connect handler 中调用：探测 → REGISTER(ack) → STATUS_REPORT + PI_STATE */
	onConnected: () => Promise<void>;
}

/**
 * 绑定 Pi Socket 桥：PI_REQUEST 响应、PI_EVENT 转发、注册后状态上报。
 * Server 完成 register 后通过 ack callback 或现有 "ack" event 通知。
 */
export function attachPiBridge(socket: Socket, deps: PiBridgeDeps): PiBridge {
	// 请求响应（信任边界：先 parse 再交给 supervisor）
	socket.on(Events.PI_REQUEST, (raw: unknown) => {
		try {
			const request = parsePiRequest(raw);
			void deps.supervisor.request(request).then((response) => {
				if (socket.connected) socket.emit(Events.PI_RESPONSE, response);
			});
		} catch {
			const requestId =
				typeof raw === "object" &&
				raw !== null &&
				"requestId" in raw &&
				typeof (raw as { requestId: unknown }).requestId === "string"
					? (raw as { requestId: string }).requestId
					: "";
			if (socket.connected) {
				socket.emit(Events.PI_RESPONSE, {
					requestId,
					ok: false,
					error: { code: "PI_PROTOCOL_INVALID", message: "Invalid request" },
				});
			}
		}
	});

	// supervisor 事件转发（断线期间不发送；Worker 继续运行）
	deps.supervisor.onEvent((event: PiEvent) => {
		if (socket.connected) socket.emit(Events.PI_EVENT, event);
	});

	let connectionGeneration = 0;
	let currentRegistered: (() => void) | null = null;

	function scheduleControlledReconnect(generation: number): void {
		socket.disconnect();
		setTimeout(() => {
			if (generation === connectionGeneration && !socket.connected) socket.connect();
		}, 100);
	}

	function reportState(generation: number, retry = 0, closureConfirmed = false): void {
		if (generation !== connectionGeneration || !socket.connected) return;
		socket.emit(Events.PI_STATE, deps.supervisor.getStateReport(), async (raw?: Partial<PiStateAck>) => {
			if (generation !== connectionGeneration) return;
			const ack: PiStateAck = {
				acceptedRunIds: raw?.acceptedRunIds ?? [],
				closedRunIds: raw?.closedRunIds ?? [],
				reportAgain: raw?.reportAgain ?? false,
			};
			const { allClosed } = await deps.supervisor.applyStateAck(ack);
			if (generation !== connectionGeneration) return;
			if (!ack.reportAgain) return;
			if (allClosed && !closureConfirmed) reportState(generation, retry, true);
			else if (!allClosed && retry < 2) setTimeout(() => reportState(generation, retry + 1), 100);
			else scheduleControlledReconnect(generation);
		});
	}

	// 兼容旧 Server：现有 "ack" event，始终绑定当前连接代次
	socket.on("ack", (data: { event?: string }) => {
		if (data?.event === Events.REGISTER) currentRegistered?.();
	});

	return {
		async onConnected() {
			const generation = ++connectionGeneration;
			let reported = false;
			const onRegistered = () => {
				if (generation !== connectionGeneration || reported) return;
				reported = true;
				socket.emit(Events.STATUS_REPORT, deps.getStatusReport());
				reportState(generation);
			};
			currentRegistered = onRegistered;
			// probe 最多等待 3 秒：超时降级为无 Pi 能力，不阻塞注册
			const piStatus = await Promise.race([
				deps.getPiStatus(),
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
			]).catch(() => undefined);
			const terminalStatus = await deps
				.getTerminalStatus()
				.catch(() => undefined);
			if (generation === connectionGeneration)
				socket.emit(Events.REGISTER, deps.getRegister(piStatus, terminalStatus), onRegistered);
		},
	};
}

export function connect(): Socket {
	const socket: Socket = io(SERVER_URL, {
		auth: { psk: PSK },
		reconnection: true,
		reconnectionDelay: 1_000,
		reconnectionDelayMax: 10_000,
	});

	const supervisor = createPiSupervisor({
		clientId: CLIENT_ID,
		forkWorker: forkProjectWorker,
	});

	// ── 终端能力（延迟探测；失败仅禁用 Terminal Tab） ──
	const terminalGenerationId = randomUUID();
	const terminalManager = createTerminalManager({
		shells: [],
		cwd: safeCwd(),
		generationId: terminalGenerationId,
		onOutput: () => undefined,
		onSessionEnded: () => undefined,
		spawnPty: createPtySpawner(),
		killTree: (pid) => killProcessTree(pid),
	});
	wireManagerToSocket(socket, terminalManager);
	attachTerminalBridge(socket, {
		clientId: CLIENT_ID,
		manager: terminalManager,
	});

	// 连接后：探测终端能力并发现 Shell（幂等，不阻塞注册超过 3 秒）
	let terminalReady: Promise<void> | null = null;
	function ensureTerminalReady(): Promise<void> {
		if (!terminalReady) {
			terminalReady = (async () => {
				const status = await probeTerminalCapability();
				if (!status.available) return;
				const shells = await discoverShells(createShellDiscoveryEnv());
				terminalManager.setShells(shells);
			})();
		}
		return terminalReady;
	}

	const bridge = attachPiBridge(socket, {
		clientId: CLIENT_ID,
		supervisor,
		getPiStatus: () => probePiCapability(),
		getTerminalStatus: () => probeTerminalCapability(),
		getRegister: (piStatus, terminalStatus) =>
			getRegisterInfo(piStatus, terminalStatus),
		getStatusReport: () => ({
			clientId: CLIENT_ID,
			jobs: getStatusReport(),
		}),
	});

	socket.on("connect", () => {
		console.log(`[vcpdeck] connected as ${CLIENT_ID}`);
		void (async () => {
			await ensureTerminalReady();
			await bridge.onConnected();
		})();
	});

	setInterval(() => {
		if (socket.connected) {
			socket.emit(Events.HEARTBEAT, getHeartbeat(getRunningJobIds()));
		}
	}, 5_000);

	socket.on(Events.JOB_DISPATCH, (data: any) => {
		console.log(`[vcpdeck] job dispatch: ${data.jobId} — ${data.type}`);
		dispatch(data, socket);
	});

	socket.on(Events.JOB_CANCEL, (data: { jobId: string }) => {
		console.log(`[vcpdeck] job cancel: ${data.jobId}`);
		killJob(data.jobId, socket);
	});

	socket.on("disconnect", (reason) => {
		console.log(`[vcpdeck] disconnected: ${reason}`);
	});

	socket.on("connect_error", (err) => {
		console.error(`[vcpdeck] connection error: ${err.message}`);
	});

	return socket;
}

/** 终端初始工作目录：home 优先，回退 process.cwd()。 */
function safeCwd(): string {
	try {
		return homedir();
	} catch {
		return process.cwd();
	}
}

/** 真实 Shell 探测环境（生产路径；兼容 MSYS 风格 PATH）。 */
function createShellDiscoveryEnv(): ShellDiscoveryEnv {
	const isWin = process.platform === "win32";
	const pathEnv = process.env.PATH ?? "";
	// MSYS/Git Bash 的 PATH 用 ":" 分隔且为虚拟路径；按实际分隔符拆分
	const dirs = pathEnv.includes(";")
		? pathEnv.split(";").filter(Boolean)
		: pathEnv.split(":").filter(Boolean);
	return {
		platform: process.platform,
		home: homedir(),
		shellEnv: process.env.SHELL,
		path: pathEnv,
		pathExt: process.env.PATHEXT ?? "",
		resolveExecutable: async (name) => {
			const { access } = await import("node:fs/promises");
			const exts = isWin
				? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
				: [""];
			const seps = isWin ? ["\\", "/"] : ["/"];
			for (const dir of dirs) {
				for (const sep of seps) {
					for (const ext of exts) {
						const candidate = dir.endsWith(sep) ? `${dir}${name}${ext}` : `${dir}${sep}${name}${ext}`;
						try {
							await access(candidate);
							return candidate;
						} catch {
							/* 继续查找 */
						}
					}
				}
			}
			// 兜底：where.exe 非 shell 调用（Windows）
			if (isWin) {
				try {
					const { spawnSync } = await import("node:child_process");
					const result = spawnSync("where.exe", [name], { windowsHide: true, encoding: "utf8" });
					if (result.status === 0 && result.stdout) {
						const first = result.stdout.split(/\r?\n/)[0]?.trim();
						if (first) return first;
					}
				} catch {
					/* 忽略 */
				}
			}
			return null;
		},
		isExecutable: async (path) => {
			try {
				const { access, constants } = await import("node:fs/promises");
				await access(path, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** node-pty spawn 适配器（require 延迟到首次创建会话）。 */
function createPtySpawner(): (opts: PtySpawnOptions) => PtyAdapter {
	let ptyModule: typeof import("node-pty") | null = null;
	return (opts) => {
		if (!ptyModule) {
			ptyModule = require("node-pty") as typeof import("node-pty");
		}
		const pty = ptyModule.spawn(opts.file, opts.args, {
			name: opts.name,
			cols: opts.cols,
			rows: opts.rows,
			cwd: opts.cwd,
			env: opts.env,
		});
		return {
			pid: pty.pid,
			write: (d) => pty.write(d),
			resize: (c, r) => pty.resize(c, r),
			kill: () => pty.kill(),
			onData: (cb) => pty.onData(cb),
			onExit: (cb) => pty.onExit((e) => cb(e.exitCode)),
		};
	};
}
