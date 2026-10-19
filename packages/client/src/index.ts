import { io, type Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
	GitSshCapability,
	MachineRegister,
	StatusReport,
	TerminalCapabilityStatus,
} from "@vcpdeck/shared";
import { CLIENT_ID, getRegisterInfo } from "./register.js";
import { getHeartbeat } from "./heartbeat.js";
import { killJob, getRunningJobIds, getStatusReport } from "./executor.js";
import { dispatch } from "./dispatcher.js";
import {
	detectInstallationInfo,
	probePrivilegedCapability,
	type RuntimeSecurityInfo,
} from "./privileged-capability.js";
import { probeTerminalCapability } from "./terminal/capability.js";
import {
	discoverShells,
	type ShellDiscoveryEnv,
} from "./terminal/shell-discovery.js";
import {
	createTerminalManager,
	type PtyAdapter,
	type PtySpawnOptions,
} from "./terminal/terminal-manager.js";
import {
	attachTerminalBridge,
	wireManagerToSocket,
} from "./terminal/protocol-bridge.js";
import { killProcessTree } from "./terminal/process-tree.js";
import { attachUpdateHandler } from "./update.js";
import { attachGitSshBridge } from "./git-ssh/git-ssh-bridge.js";
import {
	applyGitSshEnv,
	gitSshStoreOrNull,
	probeGitSshCapabilityForClient,
	refreshGitSshEnv,
} from "./git-ssh/runtime.js";
import {
	getFrpRuntimeManager,
	shutdownFrpRuntime,
} from "./frpc-daemon.js";
import { attachFrpSocketBridge, type FrpSocketBridge } from "./frp-socket-bridge.js";
import { createAcpHost } from "./acp/acp-host.js";
import { attachAcpTaskBridge } from "./acp/acp-bridge.js";
import { attachRemoteDevBridge } from "./remote-dev/remote-dev-bridge.js";
import { connectRemoteDevTunnel } from "./remote-dev/remote-dev-tunnel.js";
import { ClientLauncher } from "./launcher-control.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

const SERVER_BASE = process.env.VCPDECK_SERVER || "http://localhost:3001";
const SERVER_URL = SERVER_BASE + "/client";
const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";

// 以下常量必须在任何函数被调用前完成初始化（main() 在模块前部就会调用 connect()）。
/** 未拿到注册成功确认时的重试退避（服务端拒绝/升级后自动恢复）。 */
const REGISTER_RETRY_BASE_MS = 10_000;
const REGISTER_RETRY_MAX_MS = 60_000;
/** 断开后仍未能重连超过该时长，就退出进程交给 Launcher 拉起。 */
const CONNECTION_EXIT_AFTER_MS = 5 * 60 * 1000;
/** 服务端主动断开后的手动重连退避。 */
const MANUAL_RECONNECT_BASE_MS = 1_000;
const MANUAL_RECONNECT_MAX_MS = 30_000;

/**
 * M1 迁移验证专用模式（仅 Linux A2 迁移由安装器设置，全新安装/稳态永不进入）：
 * Client 仍执行 REGISTER 与心跳供 Server 验证身份/版本/安装/特权，
 * 但不挂载任何 operational 处理器（Job dispatch/cancel、Files、Terminal、FRP），
 * 使迁移失败回退前不产生任何业务副作用。
 */
export function isMigrationVerifyOnly(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.VCPDECK_MIGRATION_VERIFY_ONLY === "1";
}

function main() {
	connect();
}

// Auto-run when executed directly: node dist/index.js
if (require.main === module) {
	main();
}

export interface ClientBridgeDeps {
	clientId: string;
	getTerminalStatus: () => Promise<TerminalCapabilityStatus>;
	/** 运行时安全摘要：非交互特权探测 + 安装模式；每次连接探测一次，失败降级为未报告。 */
	getRuntimeSecurity: () => Promise<RuntimeSecurityInfo | undefined>;
	getRegister: (
		terminalStatus: TerminalCapabilityStatus | undefined,
		runtimeSecurity: RuntimeSecurityInfo | undefined,
		gitSshStatus: GitSshCapability | undefined,
	) => MachineRegister;
	getStatusReport: () => StatusReport;
}

export interface ClientBridge {
	/** connect handler 中调用：探测 → REGISTER(ack) → STATUS_REPORT */
	onConnected: () => Promise<void>;
}

/**
 * 绑定 Client Socket 桥：REGISTER 与注册后的 STATUS_REPORT。
 * Server 完成 register 后通过 "ack" event 通知。
 *
 * 2026-10-12 事故后加固：未拿到注册成功确认时按退避**重发 REGISTER**。
 * 配合 0.19.2 起「服务端对非法注册不断开连接」的行为，协议不匹配的客户端会
 * 保持连接并不断重试，服务端修复/升级后**自动恢复**，不再需要人工重启机器。
 */
export function attachClientBridge(
	socket: Socket,
	deps: ClientBridgeDeps,
	opts: { verifyOnly?: boolean } = {},
): ClientBridge {
	const verifyOnly = opts.verifyOnly === true;
	let connectionGeneration = 0;
	let currentRegistered: (() => void) | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryAttempt = 0;
	/** 最近一次 REGISTER 载荷与 ack 回调：未注册成功时按退避重发。 */
	let pendingRegister: {
		payload: unknown;
		onAck: (result?: unknown) => void;
	} | null = null;

	const clearRetry = (): void => {
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
	};
	const scheduleRetry = (): void => {
		if (!pendingRegister) return;
		clearRetry();
		const delay = Math.min(
			REGISTER_RETRY_BASE_MS * 2 ** retryAttempt,
			REGISTER_RETRY_MAX_MS,
		);
		retryAttempt += 1;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (!pendingRegister) return;
			socket.emit(Events.REGISTER, pendingRegister.payload, pendingRegister.onAck);
		}, delay);
	};

	// 兼容旧 Server：现有 "ack" event，始终绑定当前连接代次
	socket.on("ack", (data: { event?: string }) => {
		if (data?.event === Events.REGISTER) currentRegistered?.();
	});
	// 服务端拒绝注册（0.19.2+ 不再断开连接）：记日志并重试；旧 Server 会直接断开，
	// 由 attachConnectionRecovery 负责重连后重新注册。
	socket.on("error", (payload: unknown) => {
		console.warn(`[vcpdeck] server rejected register: ${JSON.stringify(payload)}`);
		scheduleRetry();
	});
	// 断开后不再重发；重连（onConnected）会重新注册。
	socket.on("disconnect", () => clearRetry());

	return {
		async onConnected() {
			// 连接代次：探测很慢时可能已被更新的连接取代，旧代次不得再发 REGISTER。
			const generation = ++connectionGeneration;
			let reported = false;
			const onRegistered = () => {
				if (generation !== connectionGeneration || reported) return;
				reported = true;
				clearRetry();
				retryAttempt = 0;
				pendingRegister = null;
				// 迁移验证模式：只做身份/安全验证，不下发任何工作状态。
				if (verifyOnly) return;
				socket.emit(Events.STATUS_REPORT, deps.getStatusReport());
			};
			/** socket.io ack 回调拿到的是 handler 返回值；{ok:false} 表示被拒，不算注册成功。 */
			const onAck = (result?: unknown) => {
				if (
					typeof result === "object" &&
					result !== null &&
					(result as { ok?: unknown }).ok === false
				) {
					scheduleRetry();
					return;
				}
				onRegistered();
			};
			currentRegistered = onRegistered;
			const terminalStatus = await deps.getTerminalStatus().catch(() => undefined);
			// 运行时安全摘要：探测超时/失败降级为未报告（deps 内部已包 3s 超时），不阻塞注册。
			const runtimeSecurity = await deps.getRuntimeSecurity().catch(() => undefined);
			// Git SSH 能力与注入结论必须在 REGISTER 前就绪：Server 只向已上报能力的 Client 下发密钥。
			const gitSshStatus = await probeGitSshCapabilityForClient().catch(() => undefined);
			await refreshGitSshEnv();
			if (generation !== connectionGeneration) return;
			const payload = deps.getRegister(
				terminalStatus,
				runtimeSecurity,
				gitSshStatus,
			);
			pendingRegister = { payload, onAck };
			socket.emit(Events.REGISTER, payload, onAck);
			// 未拿到注册成功确认（ack 事件或 {ok:true}）前一直按退避重试。
			scheduleRetry();
		},
	};
}

/**
 * 连接自愈（2026-10-12 事故）。
 *
 * socket.io 对“服务端主动断开”（`io server disconnect`）**不会自动重连**，
 * 必须客户端显式 `socket.connect()`；旧实现只在 `disconnect` 里打日志，
 * 一被服务端踢就进程活着、socket 永久死亡，服务端修好也不自愈。
 * 另外：长时间连不上则退出进程，交给 Launcher 的崩溃拉起（不再静默假死）。
 */
export interface ConnectionRecoveryOptions {
	/** 连续未能连上的退出阈值（默认 5 分钟）。 */
	exitAfterMs?: number;
	/** 进程退出实现（默认 process.exit；测试可注入）。 */
	exit?: (code: number) => void;
}

export function attachConnectionRecovery(
	socket: Socket,
	options: ConnectionRecoveryOptions = {},
): void {
	const exitAfterMs = options.exitAfterMs ?? CONNECTION_EXIT_AFTER_MS;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	let watchdog: ReturnType<typeof setTimeout> | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempt = 0;

	const clearWatchdog = (): void => {
		if (watchdog) {
			clearTimeout(watchdog);
			watchdog = null;
		}
	};
	const clearReconnect = (): void => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};
	// 只要一直连不上（含从未连上过）就走同一条退出路径。
	const armWatchdog = (): void => {
		if (watchdog) return;
		watchdog = setTimeout(() => {
			watchdog = null;
			console.error(
				`[vcpdeck] 已连续 ${Math.round(exitAfterMs / 1000)} 秒未能连上 Server，退出以避免静默假死`,
			);
			exit(1);
		}, exitAfterMs);
	};

	socket.on("connect", () => {
		reconnectAttempt = 0;
		clearReconnect();
		clearWatchdog();
	});

	socket.on("disconnect", (reason: string) => {
		if (reason === "io server disconnect") {
			// 服务端主动断开：socket.io 不会自动重连，这里显式重试（指数退避）。
			clearReconnect();
			const delay = Math.min(
				MANUAL_RECONNECT_BASE_MS * 2 ** reconnectAttempt,
				MANUAL_RECONNECT_MAX_MS,
			);
			reconnectAttempt += 1;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				socket.connect();
			}, delay);
		}
		armWatchdog();
	});

	socket.on("connect_error", () => armWatchdog());
}

export function connect(): Socket {
	const socket: Socket = io(SERVER_URL, {
		auth: { psk: PSK },
		reconnection: true,
		reconnectionDelay: 1_000,
		reconnectionDelayMax: 10_000,
	});

	// M1 迁移验证模式：仍注册/心跳，但不挂载任何 operational 处理器。
	const verifyOnly = isMigrationVerifyOnly();

	// 连接自愈必须先挂：服务端主动断开不会自动重连。
	attachConnectionRecovery(socket);

	// Git SSH 受管密钥桥：只有 REGISTER ack 之后才处理 Server 下发的密钥指令；
	// 数据根非法时既不挂载处理器也不上报能力（fail closed）。
	const gitSshStore = gitSshStoreOrNull();
	const gitSshBridge =
		gitSshStore && !verifyOnly
			? attachGitSshBridge(socket, {
					store: gitSshStore,
					// 安装/清理完成后立即重算注入结论，避免后续 Job 使用旧状态。
					onAck: () => {
						void refreshGitSshEnv();
					},
				})
			: null;
	socket.on("ack", (payload: { event?: string }) => {
		if (payload?.event === Events.REGISTER) gitSshBridge?.markRegistered();
	});
	// 新连接必须重新注册才允许处理密钥指令。
	socket.on("disconnect", () => gitSshBridge?.markUnregistered());

	// 自更新：有界 drain + 本机 Launcher 两阶段更新；apply 前计划内释放 frpc。
	attachUpdateHandler({
		socket,
		launcher: new ClientLauncher(),
		serverBase: SERVER_BASE,
		beforeApply: () => shutdownFrpRuntime(),
	});

	// FRP socket 桥：注册确认后上报安全 runtime 快照（每次连接新代次）。
	const frpBridge: FrpSocketBridge = attachFrpSocketBridge(socket, {
		clientId: CLIENT_ID,
		manager: getFrpRuntimeManager(),
	});

	// 进程级停机（SIGTERM/SIGINT 各一次）：
	// 先 dispose 桥（关闭本代次上报资格）→ 计划内停 frpc（防版本切换误判 crash）→ exit(0)。
	let frpShuttingDown = false;
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			if (frpShuttingDown) return;
			frpShuttingDown = true;
			frpBridge.dispose();
			void shutdownFrpRuntime()
				.catch(() => {
					console.error("[frp] 停机释放失败（忽略）");
				})
				.finally(() => process.exit(0));
		});
	}

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
	if (!verifyOnly) {
		attachAcpTaskBridge(socket, {
			clientId: CLIENT_ID,
			createHost: createAcpHost,
		});
		attachRemoteDevBridge(socket, {
			createHost: createAcpHost,
			tunnelFactory: (sessionId) =>
				connectRemoteDevTunnel({
					serverBase: SERVER_BASE,
					psk: PSK,
					clientId: CLIENT_ID,
					sessionId,
				}),
		});
	}

	// 连接后：探测终端能力并发现 Shell（幂等，不阻塞注册超过 3 秒）
	let terminalReady: Promise<void> | null = null;
	function ensureTerminalReady(): Promise<void> {
		if (!terminalReady) {
			terminalReady = (async () => {
				const status = await probeWithTimeout(probeTerminalCapability).catch(() => undefined);
				if (!status?.available) return;
				const shells = await discoverShells(createShellDiscoveryEnv());
				terminalManager.setShells(shells);
			})();
		}
		return terminalReady;
	}

	// 能力探测上限：终端/特权探测 3s，均不得阻塞 REGISTER。
	function probeWithTimeout<T>(probe: () => Promise<T>, timeoutMs = 3000): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error("capability probe timeout"));
			}, timeoutMs);
			(timer as { unref?: () => void }).unref?.();
			probe()
				.then((value) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(value);
				})
				.catch((err) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(err);
				});
		});
	}

	const bridge = attachClientBridge(
		socket,
		{
		clientId: CLIENT_ID,
		getTerminalStatus: () => probeWithTimeout(probeTerminalCapability),
		// 特权探测仅 Linux；非 Linux 两项均为 undefined → 整体未报告（保持 Windows 原语义）。
		// sudo 探测包统一 3s 超时：超时可视为非交互 sudo 不可用，失败关闭且不阻塞 REGISTER。
		getRuntimeSecurity: () =>
			probeWithTimeout(async (): Promise<RuntimeSecurityInfo | undefined> => {
				const privileged = await probePrivilegedCapability();
				const installation = detectInstallationInfo();
				if (privileged === undefined && installation === undefined) return undefined;
				const info: RuntimeSecurityInfo = {};
				if (privileged !== undefined) info.privileged = privileged;
				if (installation !== undefined) info.installation = installation;
				return info;
			}),
		getRegister: (terminalStatus, runtimeSecurity, gitSshStatus) =>
			getRegisterInfo(
				terminalStatus,
				runtimeSecurity,
				process.env,
				gitSshStatus,
			),
		getStatusReport: () => ({
			clientId: CLIENT_ID,
			jobs: getStatusReport(),
		}),
	},
		{ verifyOnly },
	);

	socket.on("connect", () => {
		console.log(`[vcpdeck] connected as ${CLIENT_ID}${verifyOnly ? "（迁移验证模式）" : ""}`);
		if (!verifyOnly) {
			// FRP 桥同步进入新连接代次（不立即恢复；REGISTER ack 后才上报状态）。
			frpBridge.onConnected();
		}
		void (async () => {
			if (!verifyOnly) {
				await ensureTerminalReady();
			}
			await bridge.onConnected();
		})();
	});

	setInterval(() => {
		if (socket.connected) {
			socket.emit(Events.HEARTBEAT, getHeartbeat(getRunningJobIds()));
		}
	}, 5_000);

	if (!verifyOnly) {
		socket.on(Events.JOB_DISPATCH, (data: any) => {
			console.log(`[vcpdeck] job dispatch: ${data.jobId} — ${data.type}`);
			dispatch(data, socket);
		});

		socket.on(Events.JOB_CANCEL, (data: { jobId: string }) => {
			console.log(`[vcpdeck] job cancel: ${data.jobId}`);
			killJob(data.jobId, socket);
		});
	}

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
						const candidate = dir.endsWith(sep)
							? `${dir}${name}${ext}`
							: `${dir}${sep}${name}${ext}`;
						try {
							await access(candidate);
							return candidate;
						} catch (error) {
							void error;
						}
					}
				}
			}
			// 兜底：where.exe 非 shell 调用（Windows）
			if (isWin) {
				try {
					const { spawnSync } = await import("node:child_process");
					const result = spawnSync("where.exe", [name], {
						windowsHide: true,
						encoding: "utf8",
					});
					if (result.status === 0 && result.stdout) {
						const first = result.stdout.split(/\r?\n/)[0]?.trim();
						if (first) return first;
					}
				} catch {
					return null;
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

/** node-pty spawn 适配器（require 延迟到首次创建会话）。
 * Windows 下优先 useConptyDll（kill 时跳过 conpty_console_list_agent，避免
 * 父进程持有 console 时 AttachConsole 失败）；构建缺少 conpty.dll 时回退默认路径。 */
function createPtySpawner(): (opts: PtySpawnOptions) => PtyAdapter {
	let ptyModule: typeof import("@lydell/node-pty") | null = null;
	return (opts) => {
		if (!ptyModule) {
			ptyModule = require("@lydell/node-pty") as typeof import("@lydell/node-pty");
		}
		const baseOptions = {
			name: opts.name,
			cols: opts.cols,
			rows: opts.rows,
			cwd: opts.cwd,
			env: opts.env,
		};
		let pty: ReturnType<typeof ptyModule.spawn>;
		if (process.platform === "win32") {
			try {
				pty = ptyModule.spawn(opts.file, opts.args, {
					...baseOptions,
					useConptyDll: true,
				});
			} catch {
				// 无 conpty.dll 的构建：回退默认 ConPTY 路径
				pty = ptyModule.spawn(opts.file, opts.args, baseOptions);
			}
		} else {
			pty = ptyModule.spawn(opts.file, opts.args, baseOptions);
		}
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
