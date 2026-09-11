"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wireManagerToSocket = wireManagerToSocket;
exports.attachTerminalBridge = attachTerminalBridge;
const shared_1 = require("@vcpdeck/shared");
const shared_2 = require("@vcpdeck/shared");
function isTerminalErrorCode(v) {
    return typeof v === "string" && shared_2.TERMINAL_ERROR_CODES.includes(v);
}
/** 将 Manager 输出/结束回调接入 socket（由 connect() 组装）。 */
function wireManagerToSocket(socket, manager) {
    manager.setOutputSink((chunk) => {
        if (socket.connected)
            socket.emit(shared_1.Events.TERMINAL_OUTPUT, chunk);
    });
    manager.setSessionEndedSink((info) => {
        if (info.reason !== "exited")
            return; // 关闭/过期由 Server 侧动作驱动
        if (socket.connected) {
            socket.emit(shared_1.Events.TERMINAL_EXIT, { sessionId: info.sessionId, exitCode: info.exitCode ?? 1 });
        }
    });
}
/**
 * 绑定终端 Socket 桥：请求响应、输出/退出转发、注册后状态对账。
 * - 所有入站消息先 parse；
 * - 高频动作（input/resize）仍等待业务完成，错误安全上报；
 * - 断线不关闭 TerminalManager（由 30 分钟保留计时兜底）。
 */
function attachTerminalBridge(socket, deps) {
    // ── 请求响应（信任边界：先 parse 再交给 Manager；响应走 TERMINAL_RESPONSE 事件） ──
    socket.on(shared_1.Events.TERMINAL_REQUEST, async (raw, _ack) => {
        let request;
        const send = (response) => {
            if (socket.connected)
                socket.emit(shared_1.Events.TERMINAL_RESPONSE, response);
        };
        try {
            request = (0, shared_2.parseTerminalClientRequest)(raw);
        }
        catch {
            const requestId = typeof raw === "object" && raw !== null && "requestId" in raw
                ? String(raw.requestId ?? "")
                : "";
            send({
                requestId,
                ok: false,
                error: { code: "TERMINAL_PROTOCOL_INVALID", message: "Invalid terminal request" },
            });
            return;
        }
        try {
            const response = await handleRequest(request);
            send(response);
        }
        catch (error) {
            const code = isTerminalErrorCode(error.code)
                ? error.code
                : "TERMINAL_PROTOCOL_INVALID";
            send({
                requestId: request.requestId,
                ok: false,
                error: { code, message: (0, shared_2.safeTerminalErrorMessage)(error.message) },
            });
        }
    });
    async function handleRequest(request) {
        const m = deps.manager;
        switch (request.action) {
            case "shells.list":
                return { requestId: request.requestId, ok: true, action: "shells.list", shells: m.listShells() };
            case "session.create": {
                await m.create({
                    sessionId: request.sessionId,
                    shellId: request.shellId,
                    cols: request.cols,
                    rows: request.rows,
                });
                return {
                    requestId: request.requestId,
                    ok: true,
                    action: "session.create",
                    sessionId: request.sessionId,
                    status: "detached",
                };
            }
            case "session.attach": {
                await m.attach(request.sessionId);
                const snap = await m.getSnapshot(request.sessionId);
                return {
                    requestId: request.requestId,
                    ok: true,
                    action: "session.attach",
                    sessionId: request.sessionId,
                    snapshot: snap.snapshot,
                    snapshotSeq: snap.snapshotSeq,
                    cols: snap.cols,
                    rows: snap.rows,
                    historyTruncated: snap.historyTruncated,
                };
            }
            case "session.detach":
                await m.detach(request.sessionId);
                return { requestId: request.requestId, ok: true, action: "session.detach", sessionId: request.sessionId };
            case "session.input":
                await m.input(request.sessionId, request.data);
                return { requestId: request.requestId, ok: true, action: "session.input", sessionId: request.sessionId };
            case "session.resize":
                await m.resize(request.sessionId, request.cols, request.rows);
                return {
                    requestId: request.requestId,
                    ok: true,
                    action: "session.resize",
                    sessionId: request.sessionId,
                    cols: request.cols,
                    rows: request.rows,
                };
            case "session.snapshot": {
                const snap = await m.getSnapshot(request.sessionId);
                return {
                    requestId: request.requestId,
                    ok: true,
                    action: "session.snapshot",
                    sessionId: request.sessionId,
                    snapshot: snap.snapshot,
                    snapshotSeq: snap.snapshotSeq,
                    cols: snap.cols,
                    rows: snap.rows,
                    historyTruncated: snap.historyTruncated,
                };
            }
            case "session.close":
                await m.close(request.sessionId, request.reason);
                return {
                    requestId: request.requestId,
                    ok: true,
                    action: "session.close",
                    sessionId: request.sessionId,
                    status: "closed",
                };
        }
    }
    // ── 注册后状态对账 ──
    socket.on("ack", (data) => {
        if (data?.event !== shared_1.Events.REGISTER)
            return;
        if (!socket.connected)
            return;
        const report = {
            ...deps.manager.getStateReport(),
            clientId: deps.clientId,
        };
        socket.emit(shared_1.Events.TERMINAL_STATE, report, (raw) => {
            try {
                const ack = (0, shared_2.parseTerminalStateAck)(raw);
                for (const sessionId of ack.closeSessionIds) {
                    void deps.manager.close(sessionId, "closed");
                }
            }
            catch {
                /* 非法 ack 忽略 */
            }
        });
    });
    // ── 断线：不关闭 Manager，交由 30 分钟保留计时 ──
    socket.on("disconnect", () => {
        deps.manager.handleServerDisconnect();
    });
}
