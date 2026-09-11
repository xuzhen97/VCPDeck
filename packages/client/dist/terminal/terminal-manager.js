"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTerminalManager = createTerminalManager;
const shared_1 = require("@vcpdeck/shared");
const shared_2 = require("@vcpdeck/shared");
const terminal_snapshot_js_1 = require("./terminal-snapshot.js");
/** 真实 xterm headless 快照环境（生产路径）。 */
function realSnapshotterEnv() {
    const { Terminal } = require("@xterm/headless");
    const { SerializeAddon } = require("@xterm/addon-serialize");
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
                write: (data, cb) => {
                    if (cb)
                        t.write(data, cb);
                    else
                        t.write(data);
                },
                resize: (cols, rows) => t.resize(cols, rows),
                serialize: () => serialize.serialize(),
                dispose: () => t.dispose(),
            };
        },
        maxSnapshotBytes: shared_1.TerminalLimits.maxSnapshotBytes,
        scrollback: shared_1.TerminalLimits.scrollbackLines,
    };
}
function terminalError(code, message) {
    return Object.assign(new Error(message), { code });
}
/** 单个终端会话管理器：registry、上限、输出流、headless 快照、保留计时与进程清理。 */
function createTerminalManager(options) {
    const maxSessions = options.maxSessions ?? shared_1.TerminalLimits.maxSessionsPerClient;
    const detachedTtlMs = options.detachedTtlMs ?? shared_1.TerminalLimits.detachedTtlMs;
    const flushWindowMs = options.flushWindowMs ?? 16;
    const sessions = new Map();
    const shellById = new Map(options.shells.map((s) => [s.id, s]));
    const baseEnv = {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
    };
    /** 继承进程环境（过滤 undefined 值）。 */
    function cleanEnv() {
        const result = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === "string")
                result[key] = value;
        }
        return result;
    }
    function activeCount() {
        return sessions.size;
    }
    // 输出/结束回调可被桥接层替换（socket 重连时重绑定）。
    let outputSink = options.onOutput;
    let sessionEndedSink = options.onSessionEnded;
    function setOutputSink(fn) {
        outputSink = fn;
    }
    function setSessionEndedSink(fn) {
        sessionEndedSink = fn;
    }
    function settle(sessionId, reason, exitCode, errorCode) {
        const session = sessions.get(sessionId);
        if (!session || session.closed)
            return;
        session.closed = true;
        clearSessionTimers(session);
        sessions.delete(sessionId);
        try {
            session.pty.kill();
        }
        catch {
            /* PTY 已释放 */
        }
        session.snapshotter.dispose();
        void options.killTree(session.pty.pid).catch(() => {
            /* 进程树清理失败不改变终态 */
        });
        sessionEndedSink({ sessionId, reason, exitCode, errorCode });
    }
    function clearSessionTimers(session) {
        if (session.expiryTimer)
            clearTimeout(session.expiryTimer);
        if (session.flushTimer)
            clearTimeout(session.flushTimer);
        session.expiryTimer = null;
        session.flushTimer = null;
    }
    /** 取 rest 的最大前缀，使 UTF-8 字节数 ≤ 上限（避免截断多字节字符）。 */
    function takeChunk(rest) {
        if ((0, shared_2.utf8ByteLength)(rest) <= shared_1.TerminalLimits.maxOutputChunkBytes)
            return rest;
        let lo = 1;
        let hi = rest.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if ((0, shared_2.utf8ByteLength)(rest.slice(0, mid)) <= shared_1.TerminalLimits.maxOutputChunkBytes) {
                lo = mid;
            }
            else {
                hi = mid - 1;
            }
        }
        return rest.slice(0, lo);
    }
    function flushOutput(session) {
        if (session.flushTimer) {
            clearTimeout(session.flushTimer);
            session.flushTimer = null;
        }
        const pending = session.pendingOutput;
        session.pendingOutput = "";
        if (pending.length === 0)
            return;
        let rest = pending;
        while (rest.length > 0) {
            const chunk = takeChunk(rest);
            rest = rest.slice(chunk.length);
            session.seq += 1;
            outputSink({ sessionId: session.sessionId, seq: session.seq, data: chunk });
        }
    }
    function queueOutput(session, data) {
        if (session.closed)
            return;
        session.pendingOutput += data;
        if (session.flushTimer)
            return;
        session.flushTimer = setTimeout(() => flushOutput(session), flushWindowMs);
    }
    function armExpiry(session) {
        if (session.expiryTimer)
            clearTimeout(session.expiryTimer);
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
        async create(request) {
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
            let pty;
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
            }
            catch {
                throw terminalError("TERMINAL_PTY_SPAWN_FAILED", "Failed to spawn shell");
            }
            const snapshotter = options.createSnapshotter
                ? options.createSnapshotter({ cols: request.cols, rows: request.rows })
                : (0, terminal_snapshot_js_1.createSnapshotter)(realSnapshotterEnv(), { cols: request.cols, rows: request.rows });
            const session = {
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
        async attach(sessionId) {
            const session = sessions.get(sessionId);
            if (!session || session.closed)
                throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
            session.liveAttached = true;
            session.detachedAt = null;
            session.expiresAt = null;
            if (session.expiryTimer)
                clearTimeout(session.expiryTimer);
            session.expiryTimer = null;
        },
        /** 最后一个浏览器离开：启动保留计时（Server 断线同样适用）。 */
        async detach(sessionId) {
            const session = sessions.get(sessionId);
            if (!session || session.closed)
                throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
            session.liveAttached = false;
            armExpiry(session);
        },
        /** Server Socket 断线：所有会话视为暂时 detached。 */
        handleServerDisconnect() {
            for (const session of sessions.values()) {
                if (session.closed)
                    continue;
                session.liveAttached = false;
                armExpiry(session);
            }
        },
        /** 写入输入（校验 UTF-8 字节上限）。 */
        async input(sessionId, data) {
            const session = sessions.get(sessionId);
            if (!session || session.closed)
                throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
            if ((0, shared_2.utf8ByteLength)(data) > shared_1.TerminalLimits.maxInputBytes) {
                throw terminalError("TERMINAL_INPUT_TOO_LARGE", "Input exceeds size limit");
            }
            session.pty.write(data);
        },
        /** 调整 PTY 尺寸（协议范围校验）。 */
        async resize(sessionId, cols, rows) {
            const session = sessions.get(sessionId);
            if (!session || session.closed)
                throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
            if (!Number.isInteger(cols) ||
                !Number.isInteger(rows) ||
                cols < shared_1.TerminalLimits.minCols ||
                cols > shared_1.TerminalLimits.maxCols ||
                rows < shared_1.TerminalLimits.minRows ||
                rows > shared_1.TerminalLimits.maxRows) {
                throw terminalError("TERMINAL_PROTOCOL_INVALID", "Invalid terminal size");
            }
            session.cols = cols;
            session.rows = rows;
            session.pty.resize(cols, rows);
            session.snapshotter.resize(cols, rows);
        },
        /** 可用 Shell 列表（安全 DTO）。 */
        listShells() {
            return [...shellById.values()].map((s) => ({
                id: s.id,
                label: s.label,
                kind: s.kind,
                isDefault: s.isDefault,
            }));
        },
        /** 设置可用 Shell（探测完成后调用，幂等）。 */
        setShells(shells) {
            shellById.clear();
            for (const shell of shells)
                shellById.set(shell.id, shell);
        },
        /** 替换输出转发回调（桥接层使用）。 */
        setOutputSink,
        /** 替换会话结束回调（桥接层使用）。 */
        setSessionEndedSink,
        /** 取会话快照（headless 画面 + snapshotSeq）。 */
        async getSnapshot(sessionId) {
            const session = sessions.get(sessionId);
            if (!session || session.closed)
                throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
            return session.snapshotter.snapshot();
        },
        /** 手动关闭 / 过期清理（幂等）。 */
        async close(sessionId, reason) {
            settle(sessionId, reason);
        },
        /** 全部关闭（进程退出）。 */
        async shutdown() {
            const ids = [...sessions.keys()];
            await Promise.all(ids.map((id) => this.close(id, "closed")));
        },
        /** 生成状态对账报告（不含敏感字段）。 */
        getStateReport() {
            const now = Date.now();
            const reports = [];
            for (const session of sessions.values()) {
                if (session.closed)
                    continue;
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
