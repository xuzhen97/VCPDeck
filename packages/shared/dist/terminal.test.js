"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const terminal_js_1 = require("./terminal.js");
const TERMINAL_PROTOCOL_INVALID = "TERMINAL_PROTOCOL_INVALID";
function expectProtocolError(fn, needle) {
    try {
        fn();
        throw new Error("expected throw");
    }
    catch (e) {
        const code = e.code;
        (0, vitest_1.expect)(code).toBe(TERMINAL_PROTOCOL_INVALID);
        if (needle) {
            const message = e.message;
            (0, vitest_1.expect)(typeof message).toBe("string");
            (0, vitest_1.expect)(message.includes(needle)).toBe(true);
        }
    }
}
(0, vitest_1.describe)("TerminalLimits 常量", () => {
    (0, vitest_1.it)("覆盖设计约束", () => {
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.maxSessionsPerClient).toBe(5);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.reconnectGraceMs).toBe(30_000);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.detachedTtlMs).toBe(30 * 60_000);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.maxInputBytes).toBe(64 * 1024);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.maxOutputChunkBytes).toBe(64 * 1024);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.maxSnapshotBytes).toBe(8 * 1024 * 1024);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.syncBacklogBytes).toBe(2 * 1024 * 1024);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.scrollbackLines).toBe(2_000);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.minCols).toBe(20);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.maxCols).toBe(500);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.minRows).toBe(5);
        (0, vitest_1.expect)(terminal_js_1.TerminalLimits.maxRows).toBe(300);
    });
    (0, vitest_1.it)("错误码包含设计约定的稳定错误码", () => {
        for (const code of [
            "TERMINAL_CLIENT_OFFLINE",
            "TERMINAL_UNSUPPORTED",
            "TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
            "TERMINAL_SESSION_NOT_FOUND",
            "TERMINAL_SESSION_LIMIT_REACHED",
            "TERMINAL_SHELL_NOT_AVAILABLE",
            "TERMINAL_SESSION_ENDED",
            "TERMINAL_READ_ONLY",
            "TERMINAL_CONTROL_PROTECTED",
            "TERMINAL_CONTROL_CONFLICT",
            "TERMINAL_PTY_SPAWN_FAILED",
            "TERMINAL_PTY_IO_FAILED",
            "TERMINAL_SNAPSHOT_FAILED",
            "TERMINAL_RESYNC_REQUIRED",
            "TERMINAL_CLIENT_RESTARTED",
            "TERMINAL_REQUEST_TIMEOUT",
            "TERMINAL_INPUT_TOO_LARGE",
            "TERMINAL_RATE_LIMITED",
            "TERMINAL_PROTOCOL_INVALID",
        ]) {
            (0, vitest_1.expect)(terminal_js_1.TERMINAL_ERROR_CODES).toContain(code);
        }
    });
    (0, vitest_1.it)("状态与审计事件 allowlist 完整", () => {
        (0, vitest_1.expect)(terminal_js_1.TERMINAL_SESSION_STATUSES).toEqual([
            "starting",
            "active",
            "detached",
            "exited",
            "interrupted",
            "expired",
            "closed",
            "error",
        ]);
        (0, vitest_1.expect)(terminal_js_1.TERMINAL_AUDIT_EVENTS).toEqual([
            "created",
            "create_failed",
            "attached",
            "detached",
            "takeover",
            "closed",
            "expired",
            "exited",
            "interrupted",
        ]);
    });
});
(0, vitest_1.describe)("utf8ByteLength 与尺寸校验", () => {
    (0, vitest_1.it)("按 UTF-8 字节而非 JS 字符计数", () => {
        (0, vitest_1.expect)((0, terminal_js_1.utf8ByteLength)("abc")).toBe(3);
        (0, vitest_1.expect)((0, terminal_js_1.utf8ByteLength)("中文")).toBe(6);
        (0, vitest_1.expect)((0, terminal_js_1.utf8ByteLength)("💩")).toBe(4);
        (0, vitest_1.expect)((0, terminal_js_1.utf8ByteLength)("")).toBe(0);
    });
    (0, vitest_1.it)("尺寸边界：20..500 列、5..300 行", () => {
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(20, 5)).toBe(true);
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(500, 300)).toBe(true);
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(19, 5)).toBe(false);
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(501, 5)).toBe(false);
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(80, 4)).toBe(false);
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(80, 301)).toBe(false);
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(80.5, 24)).toBe(false);
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(NaN, 24)).toBe(false);
        (0, vitest_1.expect)((0, terminal_js_1.isValidTerminalSize)(80, Infinity)).toBe(false);
    });
});
(0, vitest_1.describe)("parseTerminalClientRequest", () => {
    (0, vitest_1.it)("解析合法 create 请求并保留判别字段", () => {
        const parsed = (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r1",
            action: "session.create",
            sessionId: "s1",
            shellId: "pwsh",
            cols: 120,
            rows: 30,
        });
        (0, vitest_1.expect)(parsed).toEqual({
            requestId: "r1",
            action: "session.create",
            sessionId: "s1",
            shellId: "pwsh",
            cols: 120,
            rows: 30,
        });
    });
    (0, vitest_1.it)("解析合法 shells.list / input / snapshot / close 请求", () => {
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalClientRequest)({ requestId: "r", action: "shells.list" })
            .action).toBe("shells.list");
        const input = (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.input",
            sessionId: "s1",
            data: "\x03ls\r",
        });
        (0, vitest_1.expect)(input.action).toBe("session.input");
        if (input.action !== "session.input")
            throw new Error("narrow");
        (0, vitest_1.expect)(input.data).toBe("\x03ls\r");
        const close = (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.close",
            sessionId: "s1",
            reason: "expired",
        });
        (0, vitest_1.expect)(close.action).toBe("session.close");
        if (close.action !== "session.close")
            throw new Error("narrow");
        (0, vitest_1.expect)(close.reason).toBe("expired");
    });
    (0, vitest_1.it)("拒绝未知 action", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({ requestId: "r", action: "session.hack" }));
    });
    (0, vitest_1.it)("拒绝额外顶层字段", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "shells.list",
            executable: "C:\\evil.exe",
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.create",
            sessionId: "s1",
            shellId: "pwsh",
            cols: 80,
            rows: 24,
            cwd: "/tmp",
        }));
    });
    (0, vitest_1.it)("拒绝空 sessionId / 非字符串 requestId", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.input",
            sessionId: "",
            data: "x",
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({ requestId: 7, action: "shells.list" }));
    });
    (0, vitest_1.it)("拒绝超限 input（UTF-8 字节）", () => {
        const big = "a".repeat(terminal_js_1.TerminalLimits.maxInputBytes + 1);
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.input",
            sessionId: "s1",
            data: big,
        }));
        // 中文按字节计数：3 字节/字
        const cn = "中".repeat(Math.ceil(terminal_js_1.TerminalLimits.maxInputBytes / 3) + 1);
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.input",
            sessionId: "s1",
            data: cn,
        }));
    });
    (0, vitest_1.it)("拒绝非法尺寸（小数/越界）", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.create",
            sessionId: "s1",
            shellId: "pwsh",
            cols: 80.5,
            rows: 24,
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.resize",
            sessionId: "s1",
            cols: 9999,
            rows: 24,
        }));
    });
    (0, vitest_1.it)("拒绝非法 close reason", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientRequest)({
            requestId: "r",
            action: "session.close",
            sessionId: "s1",
            reason: "explode",
        }));
    });
    (0, vitest_1.it)("失败消息不回显原始 data", () => {
        const secret = "TOP_SECRET_DATA_XYZ";
        try {
            (0, terminal_js_1.parseTerminalClientRequest)({
                requestId: "r",
                action: "session.input",
                sessionId: "s1",
                data: secret + "x".repeat(terminal_js_1.TerminalLimits.maxInputBytes),
            });
            throw new Error("expected throw");
        }
        catch (e) {
            const message = e.message;
            (0, vitest_1.expect)(message.includes(secret)).toBe(false);
        }
    });
});
(0, vitest_1.describe)("parseTerminalClientResponse", () => {
    (0, vitest_1.it)("解析合法 snapshot 响应", () => {
        const parsed = (0, terminal_js_1.parseTerminalClientResponse)({
            requestId: "r1",
            ok: true,
            action: "session.snapshot",
            sessionId: "s1",
            snapshot: "\x1b[31mhi",
            snapshotSeq: 42,
            cols: 120,
            rows: 30,
            historyTruncated: false,
        });
        if (parsed.action !== "session.snapshot")
            throw new Error("narrow");
        (0, vitest_1.expect)(parsed.action).toBe("session.snapshot");
        (0, vitest_1.expect)(parsed.snapshotSeq).toBe(42);
        (0, vitest_1.expect)(parsed.snapshot).toBe("\x1b[31mhi");
    });
    (0, vitest_1.it)("解析合法错误响应", () => {
        const parsed = (0, terminal_js_1.parseTerminalClientResponse)({
            requestId: "r1",
            ok: false,
            error: { code: "TERMINAL_PTY_SPAWN_FAILED", message: "spawn failed" },
        });
        (0, vitest_1.expect)(parsed.ok).toBe(false);
        if (parsed.ok)
            throw new Error("narrow");
        (0, vitest_1.expect)(parsed.error.code).toBe("TERMINAL_PTY_SPAWN_FAILED");
    });
    (0, vitest_1.it)("拒绝非法错误码、超限 snapshot、缺失判别字段", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientResponse)({
            requestId: "r1",
            ok: false,
            error: { code: "EVERYTHING_IS_FINE", message: "x" },
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientResponse)({
            requestId: "r1",
            ok: true,
            action: "session.snapshot",
            sessionId: "s1",
            snapshot: "x".repeat(terminal_js_1.TerminalLimits.maxSnapshotBytes + 1),
            snapshotSeq: 1,
            cols: 80,
            rows: 24,
            historyTruncated: false,
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalClientResponse)({
            requestId: "r1",
            ok: true,
            action: "session.detach",
        }));
    });
});
(0, vitest_1.describe)("parseTerminalOutputChunk", () => {
    (0, vitest_1.it)("解析合法块并保留 seq", () => {
        const parsed = (0, terminal_js_1.parseTerminalOutputChunk)({
            sessionId: "s1",
            seq: 7,
            data: "ok",
        });
        (0, vitest_1.expect)(parsed.seq).toBe(7);
    });
    (0, vitest_1.it)("拒绝负 seq、NaN、空块、超限块和额外字段", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalOutputChunk)({ sessionId: "s1", seq: -1, data: "x" }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalOutputChunk)({ sessionId: "s1", seq: NaN, data: "x" }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalOutputChunk)({ sessionId: "s1", seq: 1, data: "" }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalOutputChunk)({
            sessionId: "s1",
            seq: 1,
            data: "x".repeat(terminal_js_1.TerminalLimits.maxOutputChunkBytes + 1),
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalOutputChunk)({
            sessionId: "s1",
            seq: 1,
            data: "x",
            cwd: "/tmp",
        }));
    });
});
(0, vitest_1.describe)("parseTerminalExitReport", () => {
    (0, vitest_1.it)("解析合法退出报告", () => {
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalExitReport)({ sessionId: "s1", exitCode: 0 }).exitCode).toBe(0);
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalExitReport)({ sessionId: "s1", exitCode: -1073741510 })
            .exitCode).toBe(-1073741510);
    });
    (0, vitest_1.it)("拒绝非整数 exitCode 和额外字段", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalExitReport)({ sessionId: "s1", exitCode: 1.5 }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalExitReport)({ sessionId: "s1", exitCode: NaN }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalExitReport)({ sessionId: "s1", exitCode: 0, reason: "x" }));
    });
});
(0, vitest_1.describe)("parseTerminalStateReport", () => {
    const base = {
        clientId: "c1",
        generationId: "g1",
        sessions: [
            {
                sessionId: "s1",
                shellId: "pwsh",
                status: "active",
                cols: 120,
                rows: 30,
                lastSeq: 10,
            },
        ],
    };
    (0, vitest_1.it)("解析合法报告", () => {
        const parsed = (0, terminal_js_1.parseTerminalStateReport)(base);
        (0, vitest_1.expect)(parsed.clientId).toBe("c1");
        (0, vitest_1.expect)(parsed.sessions[0].status).toBe("active");
    });
    (0, vitest_1.it)("解析带 detachedAt/expiresAt 的报告", () => {
        const parsed = (0, terminal_js_1.parseTerminalStateReport)({
            ...base,
            sessions: [
                {
                    ...base.sessions[0],
                    status: "detached",
                    detachedAt: "2026-08-12T00:00:00.000Z",
                    expiresAt: "2026-08-12T00:30:00.000Z",
                },
            ],
        });
        (0, vitest_1.expect)(parsed.sessions[0].detachedAt).toBeTruthy();
    });
    (0, vitest_1.it)("拒绝错误 clientId 类型、重复 sessionId、非法日期", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalStateReport)({ ...base, clientId: 42 }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalStateReport)({
            ...base,
            sessions: [base.sessions[0], { ...base.sessions[0] }],
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalStateReport)({
            ...base,
            sessions: [{ ...base.sessions[0], detachedAt: "not-a-date" }],
        }));
    });
    (0, vitest_1.it)("拒绝非法状态、非法尺寸、会话数超限", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalStateReport)({
            ...base,
            sessions: [{ ...base.sessions[0], status: "zombie" }],
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalStateReport)({
            ...base,
            sessions: [{ ...base.sessions[0], cols: 3 }],
        }));
        const tooMany = Array.from({ length: terminal_js_1.TerminalLimits.maxSessionsPerClient + 1 }, (_, i) => ({
            ...base.sessions[0],
            sessionId: `s${i}`,
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalStateReport)({ ...base, sessions: tooMany }));
    });
});
(0, vitest_1.describe)("parseTerminalStateAck", () => {
    (0, vitest_1.it)("解析合法 ack 并应用默认值", () => {
        const parsed = (0, terminal_js_1.parseTerminalStateAck)({
            acceptedSessionIds: ["s1"],
            closeSessionIds: [],
        });
        (0, vitest_1.expect)(parsed.acceptedSessionIds).toEqual(["s1"]);
    });
    (0, vitest_1.it)("拒绝非法字段", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalStateAck)({ acceptedSessionIds: [7] }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalStateAck)({
            acceptedSessionIds: [],
            closeSessionIds: [],
            extra: 1,
        }));
    });
});
(0, vitest_1.describe)("parseTerminalSessionCreateRequest（REST）", () => {
    (0, vitest_1.it)("解析合法请求", () => {
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalSessionCreateRequest)({
            shellId: "bash",
            cols: 120,
            rows: 30,
        })).toEqual({
            shellId: "bash",
            cols: 120,
            rows: 30,
        });
    });
    (0, vitest_1.it)("拒绝 executable/args/cwd/env 字段", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalSessionCreateRequest)({
            shellId: "bash",
            cols: 80,
            rows: 24,
            executable: "/bin/sh",
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalSessionCreateRequest)({
            shellId: "bash",
            cols: 80,
            rows: 24,
            args: ["--login"],
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalSessionCreateRequest)({
            shellId: "bash",
            cols: 80,
            rows: 24,
            cwd: "/root",
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalSessionCreateRequest)({
            shellId: "bash",
            cols: 80,
            rows: 24,
            env: { FOO: "1" },
        }));
    });
    (0, vitest_1.it)("拒绝缺字段和非法尺寸", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalSessionCreateRequest)({ cols: 80, rows: 24 }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalSessionCreateRequest)({ shellId: "bash", cols: 80 }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalSessionCreateRequest)({
            shellId: "bash",
            cols: 80.5,
            rows: 24,
        }));
    });
});
(0, vitest_1.describe)("浏览器消息 parser", () => {
    (0, vitest_1.it)("解析合法 attach（含/不含 reconnectToken）", () => {
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalBrowserAttach)({ sessionId: "s1" }).reconnectToken).toBeUndefined();
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalBrowserAttach)({ sessionId: "s1", reconnectToken: "tok" })
            .reconnectToken).toBe("tok");
        expectProtocolError(() => (0, terminal_js_1.parseTerminalBrowserAttach)({ sessionId: "s1", reconnectToken: "" }));
    });
    (0, vitest_1.it)("解析合法 input/resize/takeover/detach/ack/resync", () => {
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalBrowserInput)({
            sessionId: "s1",
            attachmentId: "a1",
            data: "x",
        }).data).toBe("x");
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalBrowserResize)({
            sessionId: "s1",
            attachmentId: "a1",
            cols: 100,
            rows: 40,
        })).toEqual({
            sessionId: "s1",
            attachmentId: "a1",
            cols: 100,
            rows: 40,
        });
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalBrowserTakeover)({ sessionId: "s1", attachmentId: "a1" })
            .attachmentId).toBe("a1");
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalBrowserDetach)({ sessionId: "s1", attachmentId: "a1" })
            .sessionId).toBe("s1");
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalBrowserAckOutput)({
            sessionId: "s1",
            attachmentId: "a1",
            seq: 5,
        }).seq).toBe(5);
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalBrowserResync)({ sessionId: "s1", attachmentId: "a1" })
            .attachmentId).toBe("a1");
    });
    (0, vitest_1.it)("拒绝越权字段和非法 input 尺寸", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalBrowserInput)({
            sessionId: "s1",
            attachmentId: "a1",
            data: "x",
            token: "t",
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalBrowserInput)({
            sessionId: "s1",
            attachmentId: "a1",
            data: "",
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalBrowserInput)({
            sessionId: "s1",
            attachmentId: "a1",
            data: "x".repeat(terminal_js_1.TerminalLimits.maxInputBytes + 1),
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalBrowserResize)({
            sessionId: "s1",
            attachmentId: "a1",
            cols: 10,
            rows: 40,
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalBrowserAckOutput)({
            sessionId: "s1",
            attachmentId: "a1",
            seq: -1,
        }));
    });
});
(0, vitest_1.describe)("Server → Browser 消息 parser", () => {
    (0, vitest_1.it)("解析合法 snapshot/control/state/error", () => {
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalSnapshotMessage)({
            sessionId: "s1",
            snapshot: "x",
            snapshotSeq: 3,
            cols: 80,
            rows: 24,
            historyTruncated: true,
        }).historyTruncated).toBe(true);
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalControlState)({
            sessionId: "s1",
            mode: "operator",
            operatorName: "admin",
            controlProtectedUntil: null,
            canTakeover: false,
        }).mode).toBe("operator");
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalSessionStateMessage)({
            sessionId: "s1",
            status: "interrupted",
            reason: "restarted",
        }).status).toBe("interrupted");
        (0, vitest_1.expect)((0, terminal_js_1.parseTerminalError)({
            sessionId: "s1",
            code: "TERMINAL_READ_ONLY",
            message: "readonly",
        }).code).toBe("TERMINAL_READ_ONLY");
    });
    (0, vitest_1.it)("拒绝非法模式/状态/错误码", () => {
        expectProtocolError(() => (0, terminal_js_1.parseTerminalControlState)({
            sessionId: "s1",
            mode: "superuser",
            operatorName: null,
            controlProtectedUntil: null,
            canTakeover: false,
        }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalSessionStateMessage)({ sessionId: "s1", status: "frozen" }));
        expectProtocolError(() => (0, terminal_js_1.parseTerminalError)({ sessionId: "s1", code: "WHATEVER", message: "x" }));
    });
});
(0, vitest_1.describe)("terminalErrorCode 帮助函数", () => {
    (0, vitest_1.it)("返回稳定错误对象", () => {
        const err = (0, terminal_js_1.terminalErrorCode)("TERMINAL_READ_ONLY", "readonly");
        (0, vitest_1.expect)(err.code).toBe("TERMINAL_READ_ONLY");
        (0, vitest_1.expect)(err.message).toBe("readonly");
    });
    (0, vitest_1.it)("类型守卫正确", () => {
        (0, vitest_1.expect)((0, terminal_js_1.isTerminalSessionStatus)("active")).toBe(true);
        (0, vitest_1.expect)((0, terminal_js_1.isTerminalSessionStatus)("nope")).toBe(false);
        (0, vitest_1.expect)((0, terminal_js_1.isTerminalAuditEventName)("takeover")).toBe(true);
        (0, vitest_1.expect)((0, terminal_js_1.isTerminalAuditEventName)("nope")).toBe(false);
    });
});
