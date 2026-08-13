import type { TerminalOutputChunk, TerminalStateReport, TerminalStateSession } from "@vcpdeck/shared";
import { TerminalLimits } from "@vcpdeck/shared";
import { utf8ByteLength } from "@vcpdeck/shared";
import type { ShellRegistryEntry } from "./shell-discovery.js";
import type { TerminalShellInfo } from "@vcpdeck/shared";
import { createSnapshotter, type SnapshotterEnv, type TerminalSnapshotResult } from "./terminal-snapshot.js";

/** PTY 适配器（node-pty 的最小可测试面）。 */
export interface PtyAdapter {
	pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	onData(cb: (data: string) => void): void;
	onExit(cb: (exitCode: number) => void): void;
}

/** PTY 创建参数（固定参数，浏览器不可注入）。 */
export interface PtySpawnOptions {
	file: string;
	args: string[];
	cols: number;
	rows: number;
	cwd: string;
	env: Record<string, string>;
	name: string;
}

export interface TerminalManagerOptions {
	shells: ShellRegistryEntry[];
	cwd: string;
	generationId: string;
	onOutput: (chunk: TerminalOutputChunk) => void;
	onSessionEnded: (info: {
		sessionId: string;
		reason: "exited" | "closed" | "expired" | "error";
		exitCode?: number;
		errorCode?: string;
	}) => void;
	spawnPty: (opts: PtySpawnOptions) => PtyAdapter;
	killTree: (pid: number) => Promise<void>;
	/** 快照器工厂（默认真实 xterm headless）。 */
	createSnapshotter?: (opts: { cols: number; rows: number }) => ReturnType<typeof createSnapshotter>;
	maxSessions?: number;
	detachedTtlMs?: number;
	flushWindowMs?: number;
}

interface ActiveSession {
	sessionId: string;
	shellId: string;
	pty: PtyAdapter;
	snapshotter: ReturnType<typeof createSnapshotter>;
	seq: number;
	cols: number;
	rows: number;
	liveAttached: boolean;
	detachedAt: number | null;
	expiresAt: number | null;
	expiryTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
	pendingOutput: string;
	flushTimer: ReturnType<typeof setTimeout> | null;
}

/** 真实 xterm headless 快照环境（生产路径）。 */
function realSnapshotterEnv(): SnapshotterEnv {
	const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
	const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
	return {
		createTerminal: (opts) => {
			const t = new Terminal({
				cols: opts.cols,
				rows: opts.rows,
				scrollback: opts.scrollback,
				allowProposedApi: true,
			});
			const serialize = new SerializeAddon();
			t.loadAddon(serialize);
			return {
				write: (data: string, cb?: () => void) => {
					if (cb) t.write(data, cb);
					else t.write(data);
				},
				resize: (cols, rows) => t.resize(cols, rows),
				serialize: () => serialize.serialize(),
				dispose: () => t.dispose(),
			};
		},
		maxSnapshotBytes: TerminalLimits.maxSnapshotBytes,
		scrollback: TerminalLimits.scrollbackLines,
	};
}
function terminalError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/** 单个终端会话管理器：registry、上限、输出流、headless 快照、保留计时与进程清理。 */
export function createTerminalManager(options: TerminalManagerOptions) {
	const maxSessions = options.maxSessions ?? TerminalLimits.maxSessionsPerClient;
	const detachedTtlMs = options.detachedTtlMs ?? TerminalLimits.detachedTtlMs;
	const flushWindowMs = options.flushWindowMs ?? 16;
	const sessions = new Map<string, ActiveSession>();
	const shellById = new Map(options.shells.map((s) => [s.id, s]));
	const baseEnv: Record<string, string> = {
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	};

	/** 继承进程环境（过滤 undefined 值）。 */
	function cleanEnv(): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") result[key] = value;
		}
		return result;
	}

	function activeCount(): number {
		return sessions.size;
	}

	// 输出/结束回调可被桥接层替换（socket 重连时重绑定）。
	let outputSink = options.onOutput;
	let sessionEndedSink = options.onSessionEnded;

	function setOutputSink(fn: typeof options.onOutput): void {
		outputSink = fn;
	}

	function setSessionEndedSink(fn: typeof options.onSessionEnded): void {
		sessionEndedSink = fn;
	}

	function settle(
		sessionId: string,
		reason: "exited" | "closed" | "expired" | "error",
		exitCode?: number,
		errorCode?: string,
	): void {
		const session = sessions.get(sessionId);
		if (!session || session.closed) return;
		session.closed = true;
		clearSessionTimers(session);
		sessions.delete(sessionId);
		try {
			session.pty.kill();
		} catch {
			/* PTY 已释放 */
		}
		session.snapshotter.dispose();
		void options.killTree(session.pty.pid).catch(() => {
			/* 进程树清理失败不改变终态 */
		});
		sessionEndedSink({ sessionId, reason, exitCode, errorCode });
	}

	function clearSessionTimers(session: ActiveSession): void {
		if (session.expiryTimer) clearTimeout(session.expiryTimer);
		if (session.flushTimer) clearTimeout(session.flushTimer);
		session.expiryTimer = null;
		session.flushTimer = null;
	}

	/** 取 rest 的最大前缀，使 UTF-8 字节数 ≤ 上限（避免截断多字节字符）。 */
	function takeChunk(rest: string): string {
		if (utf8ByteLength(rest) <= TerminalLimits.maxOutputChunkBytes) return rest;
		let lo = 1;
		let hi = rest.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (utf8ByteLength(rest.slice(0, mid)) <= TerminalLimits.maxOutputChunkBytes) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		return rest.slice(0, lo);
	}

	function flushOutput(session: ActiveSession): void {
		if (session.flushTimer) {
			clearTimeout(session.flushTimer);
			session.flushTimer = null;
		}
		const pending = session.pendingOutput;
		session.pendingOutput = "";
		if (pending.length === 0) return;
		let rest = pending;
		while (rest.length > 0) {
			const chunk = takeChunk(rest);
			rest = rest.slice(chunk.length);
			session.seq += 1;
			outputSink({ sessionId: session.sessionId, seq: session.seq, data: chunk });
		}
	}

	function queueOutput(session: ActiveSession, data: string): void {
		if (session.closed) return;
		session.pendingOutput += data;
		if (session.flushTimer) return;
		session.flushTimer = setTimeout(() => flushOutput(session), flushWindowMs);
	}

	function armExpiry(session: ActiveSession): void {
		if (session.expiryTimer) clearTimeout(session.expiryTimer);
		session.detachedAt = Date.now();
		session.expiresAt = Date.now() + detachedTtlMs;
		session.expiryTimer = setTimeout(() => {
			// 只清理仍未 attach 的会话
			if (!session.liveAttached && !session.closed) {
				settle(session.sessionId, "expired");
			}
		}, detachedTtlMs);
	}

	return {
		/** 创建 PTY 会话（Server 下发 sessionId；缺失时本地生成）。 */
		async create(request: { sessionId?: string; shellId: string; cols: number; rows: number }): Promise<{ sessionId: string }> {
			if (activeCount() >= maxSessions) {
				throw terminalError("TERMINAL_SESSION_LIMIT_REACHED", "Terminal session limit reached");
			}
			const shell = shellById.get(request.shellId);
			if (!shell) {
				throw terminalError("TERMINAL_SHELL_NOT_AVAILABLE", "Requested shell is not available");
			}
			const sessionId = request.sessionId ?? `ts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
			if (sessions.has(sessionId)) {
				throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session already exists");
			}
			let pty: PtyAdapter;
			try {
				pty = options.spawnPty({
					file: shell.executable,
					args: shell.args,
					cols: request.cols,
					rows: request.rows,
					cwd: options.cwd,
					env: { ...baseEnv, ...cleanEnv() },
					name: "xterm-256color",
				});
			} catch {
				throw terminalError("TERMINAL_PTY_SPAWN_FAILED", "Failed to spawn shell");
			}
			const snapshotter = options.createSnapshotter
				? options.createSnapshotter({ cols: request.cols, rows: request.rows })
				: createSnapshotter(realSnapshotterEnv(), { cols: request.cols, rows: request.rows });
			const session: ActiveSession = {
				sessionId,
				shellId: request.shellId,
				pty,
				snapshotter,
				seq: 0,
				cols: request.cols,
				rows: request.rows,
				liveAttached: true,
				detachedAt: null,
				expiresAt: null,
				expiryTimer: null,
				closed: false,
				pendingOutput: "",
				flushTimer: null,
			};
			pty.onData((data) => {
				queueOutput(session, data);
				session.snapshotter.write(data);
			});
			pty.onExit((exitCode) => settle(session.sessionId, "exited", exitCode));
			sessions.set(sessionId, session);
			return { sessionId };
		},

		/** 浏览器 attach：取消保留计时，标记 live。 */
		async attach(sessionId: string): Promise<void> {
			const session = sessions.get(sessionId);
			if (!session || session.closed) throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
			session.liveAttached = true;
			session.detachedAt = null;
			session.expiresAt = null;
			if (session.expiryTimer) clearTimeout(session.expiryTimer);
			session.expiryTimer = null;
		},

		/** 最后一个浏览器离开：启动保留计时（Server 断线同样适用）。 */
		async detach(sessionId: string): Promise<void> {
			const session = sessions.get(sessionId);
			if (!session || session.closed) throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
			session.liveAttached = false;
			armExpiry(session);
		},

		/** Server Socket 断线：所有会话视为暂时 detached。 */
		handleServerDisconnect(): void {
			for (const session of sessions.values()) {
				if (session.closed) continue;
				session.liveAttached = false;
				armExpiry(session);
			}
		},

		/** 写入输入（校验 UTF-8 字节上限）。 */
		async input(sessionId: string, data: string): Promise<void> {
			const session = sessions.get(sessionId);
			if (!session || session.closed) throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
			if (utf8ByteLength(data) > TerminalLimits.maxInputBytes) {
				throw terminalError("TERMINAL_INPUT_TOO_LARGE", "Input exceeds size limit");
			}
			session.pty.write(data);
		},

		/** 调整 PTY 尺寸（协议范围校验）。 */
		async resize(sessionId: string, cols: number, rows: number): Promise<void> {
			const session = sessions.get(sessionId);
			if (!session || session.closed) throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
			if (
				!Number.isInteger(cols) ||
				!Number.isInteger(rows) ||
				cols < TerminalLimits.minCols ||
				cols > TerminalLimits.maxCols ||
				rows < TerminalLimits.minRows ||
				rows > TerminalLimits.maxRows
			) {
				throw terminalError("TERMINAL_PROTOCOL_INVALID", "Invalid terminal size");
			}
			session.cols = cols;
			session.rows = rows;
			session.pty.resize(cols, rows);
			session.snapshotter.resize(cols, rows);
		},

		/** 可用 Shell 列表（安全 DTO）。 */
		listShells(): TerminalShellInfo[] {
			return [...shellById.values()].map((s) => ({
				id: s.id,
				label: s.label,
				kind: s.kind,
				isDefault: s.isDefault,
			}));
		},

		/** 设置可用 Shell（探测完成后调用，幂等）。 */
		setShells(shells: ShellRegistryEntry[]): void {
			shellById.clear();
			for (const shell of shells) shellById.set(shell.id, shell);
		},

		/** 替换输出转发回调（桥接层使用）。 */
		setOutputSink,

		/** 替换会话结束回调（桥接层使用）。 */
		setSessionEndedSink,

		/** 取会话快照（headless 画面 + snapshotSeq）。 */
		async getSnapshot(sessionId: string): Promise<TerminalSnapshotResult> {
			const session = sessions.get(sessionId);
			if (!session || session.closed) throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
			return session.snapshotter.snapshot();
		},

		/** 手动关闭 / 过期清理（幂等）。 */
		async close(sessionId: string, reason: "closed" | "expired"): Promise<void> {
			settle(sessionId, reason);
		},

		/** 全部关闭（进程退出）。 */
		async shutdown(): Promise<void> {
			const ids = [...sessions.keys()];
			await Promise.all(ids.map((id) => this.close(id, "closed")));
		},

		/** 生成状态对账报告（不含敏感字段）。 */
		getStateReport(): TerminalStateReport {
			const now = Date.now();
			const reports: TerminalStateSession[] = [];
			for (const session of sessions.values()) {
				if (session.closed) continue;
				reports.push({
					sessionId: session.sessionId,
					shellId: session.shellId,
					status: session.liveAttached ? "active" : "detached",
					cols: session.cols,
					rows: session.rows,
					lastSeq: session.seq,
					...(session.detachedAt ? { detachedAt: new Date(session.detachedAt).toISOString() } : {}),
					...(session.expiresAt ? { expiresAt: new Date(session.expiresAt).toISOString() } : {}),
				});
			}
			return { clientId: "", generationId: options.generationId, sessions: reports };
		},
	};
}
