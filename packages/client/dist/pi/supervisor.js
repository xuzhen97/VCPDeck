"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.piRequestId = void 0;
exports.createPiSupervisor = createPiSupervisor;
exports.wrapPiEvent = wrapPiEvent;
const node_crypto_1 = require("node:crypto");
Object.defineProperty(exports, "piRequestId", { enumerable: true, get: function () { return node_crypto_1.randomUUID; } });
const filesystem_roots_js_1 = require("../filesystem-roots.js");
const project_path_js_1 = require("./project-path.js");
/** 单个请求等待 Worker 响应的上限 */
const REQUEST_TIMEOUT_MS = 15_000;
function piResponse(requestId, data) {
    return { requestId, ok: true, data };
}
function piError(requestId, code, message) {
    return { requestId, ok: false, error: { code, message } };
}
const DESTRUCTIVE_ACTIONS = new Set([
    "session.rename",
    "session.delete",
    "session.fork",
    "session.clone",
    "session.navigate",
    "model.set",
    "thinking.set",
]);
function createPiSupervisor(options) {
    const { clientId, forkWorker } = options;
    const rootsProvider = options.rootsProvider ?? filesystem_roots_js_1.discoverRoots;
    const registry = new Map();
    /** 已退出 Worker 的终态摘要（registry 清理后仍保留直到 ack） */
    const orphanTerminals = [];
    /** runId → envelope/cwd（终态后 settlement 查询回退；仅内存，不上报） */
    const terminalCwd = new Map();
    const eventListeners = [];
    const pending = new Map();
    function emitEvent(event) {
        for (const l of eventListeners)
            l(event);
    }
    async function resolveKey(request) {
        if (request.cwdRef) {
            const roots = await rootsProvider();
            const { cwd, key } = await (0, project_path_js_1.resolveProjectCwd)(request.cwdRef, roots);
            return { key, cwd };
        }
        if (request.jobId) {
            for (const [key, entry] of registry) {
                if (entry.activeRun?.jobId === request.jobId &&
                    (!request.runId || entry.activeRun.runId === request.runId)) {
                    return { key, cwd: entry.cwd };
                }
            }
            // settlement 在 activeRun 清除后查询：按 runId 回退，避免同 Session 多轮冲突
            const settled = request.runId
                ? terminalCwd.get(request.runId)
                : undefined;
            if (settled && settled.jobId === request.jobId) {
                return {
                    key: (0, project_path_js_1.projectKeyFor)((0, project_path_js_1.canonicalPath)(settled.cwd)),
                    cwd: settled.cwd,
                };
            }
            throw { code: "PI_SESSION_NOT_FOUND", message: "No active run for job" };
        }
        throw {
            code: "PI_PROTOCOL_INVALID",
            message: "Request needs cwdRef or jobId",
        };
    }
    function entryFor(key, cwd) {
        const existing = registry.get(key);
        if (existing)
            return existing;
        const handle = forkWorker(cwd);
        const entry = {
            cwd,
            handle,
            activeRun: null,
            terminals: [],
            mutationQueue: Promise.resolve(),
        };
        registry.set(key, entry);
        handle.onMessage((msg) => {
            if (msg.type === "response") {
                const p = pending.get(msg.requestId);
                if (p) {
                    clearTimeout(p.timer);
                    pending.delete(msg.requestId);
                    if (msg.ok) {
                        p.resolve({ requestId: msg.requestId, ok: true, data: msg.data });
                    }
                    else {
                        p.resolve({
                            requestId: msg.requestId,
                            ok: false,
                            error: {
                                code: msg.error.code,
                                message: msg.error.message,
                            },
                        });
                    }
                }
                return;
            }
            if (msg.type === "event") {
                const run = entry.activeRun;
                if (run && msg.jobId === run.jobId && msg.runId === run.runId) {
                    if (msg.event.type === "extension_request" &&
                        isDialogKind(msg.event.ui?.kind)) {
                        run.status = "waiting_input";
                    }
                    if (msg.event.type === "extension_resolved" &&
                        msg.event.hasPending === false) {
                        run.status = "running";
                    }
                    if (msg.event.type === "agent_settled") {
                        entry.terminals.push({
                            jobId: run.jobId,
                            runId: run.runId,
                            sessionId: run.sessionId,
                            status: "done",
                            projectKey: run.projectKey,
                        });
                        terminalCwd.set(run.runId, {
                            cwd: entry.cwd,
                            jobId: run.jobId,
                            sessionId: run.sessionId,
                        });
                        entry.activeRun = null;
                    }
                    if (msg.event.type === "prompt_error") {
                        entry.terminals.push({
                            jobId: run.jobId,
                            runId: run.runId,
                            sessionId: run.sessionId,
                            status: "error",
                            projectKey: run.projectKey,
                        });
                        terminalCwd.set(run.runId, {
                            cwd: entry.cwd,
                            jobId: run.jobId,
                            sessionId: run.sessionId,
                        });
                        entry.activeRun = null;
                    }
                }
                emitEvent({
                    clientId,
                    sessionId: msg.sessionId,
                    jobId: msg.jobId,
                    runId: msg.runId,
                    event: msg.event,
                });
            }
        });
        handle.onExit(() => {
            if (entry.activeRun) {
                const run = entry.activeRun;
                orphanTerminals.push({
                    jobId: run.jobId,
                    runId: run.runId,
                    sessionId: run.sessionId,
                    status: "error",
                    projectKey: run.projectKey,
                });
                entry.activeRun = null;
            }
            for (const t of entry.terminals)
                orphanTerminals.push(t);
            registry.delete(key);
        });
        return entry;
    }
    function requestViaWorker(entry, projectKey, request, timeoutMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pending.delete(request.requestId);
                resolve(piError(request.requestId, "PI_REQUEST_TIMEOUT", "Worker did not respond in time"));
            }, timeoutMs);
            pending.set(request.requestId, { resolve, timer });
            entry.handle.send({ type: "request", projectKey, request });
        });
    }
    return {
        async request(request, timeoutMs = REQUEST_TIMEOUT_MS) {
            try {
                if (request.action === "project.resolve") {
                    if (!request.cwdRef) {
                        return piError(request.requestId, "PI_PROTOCOL_INVALID", "project.resolve needs cwdRef");
                    }
                    const { key } = await resolveKey(request);
                    return piResponse(request.requestId, { projectKey: key });
                }
                const { key, cwd } = await resolveKey(request);
                const entry = entryFor(key, cwd);
                if (request.action === "agent.prompt") {
                    if (entry.activeRun) {
                        return piError(request.requestId, "PI_PROJECT_BUSY", "Project has an active turn");
                    }
                    entry.activeRun = {
                        jobId: request.jobId ?? "",
                        runId: request.runId ?? request.jobId ?? "",
                        sessionId: request.sessionId ?? "",
                        projectKey: key,
                        status: "running",
                    };
                }
                else if (DESTRUCTIVE_ACTIONS.has(request.action)) {
                    if (entry.activeRun) {
                        return piError(request.requestId, "PI_PROJECT_BUSY", "Project has an active turn");
                    }
                    // 空闲 mutation 串行：等前一个完成
                    const previous = entry.mutationQueue;
                    let done;
                    entry.mutationQueue = new Promise((res) => {
                        done = res;
                    });
                    await previous;
                    const result = await requestViaWorker(entry, key, request, timeoutMs);
                    done();
                    return result;
                }
                const run = entry.activeRun;
                const result = await requestViaWorker(entry, key, request, timeoutMs);
                if (((request.action === "agent.prompt" && !result.ok) ||
                    (request.action === "agent.abort" && result.ok)) &&
                    run?.jobId === request.jobId &&
                    run?.sessionId === request.sessionId &&
                    run?.runId === request.runId &&
                    entry.activeRun === run) {
                    entry.activeRun = null;
                }
                return result;
            }
            catch (err) {
                const code = typeof err === "object" && err !== null && "code" in err
                    ? String(err.code)
                    : "PI_PROTOCOL_INVALID";
                return piError(request.requestId, code, err instanceof Error ? err.message : "Request failed");
            }
        },
        getStateReport() {
            const runs = [...orphanTerminals];
            for (const entry of registry.values()) {
                if (entry.activeRun) {
                    runs.push({
                        jobId: entry.activeRun.jobId,
                        runId: entry.activeRun.runId,
                        sessionId: entry.activeRun.sessionId,
                        status: entry.activeRun.status,
                        projectKey: entry.activeRun.projectKey,
                    });
                }
                for (const t of entry.terminals)
                    runs.push(t);
            }
            return { clientId, runs };
        },
        async applyStateAck(ack) {
            const accepted = new Set(ack.acceptedRunIds);
            for (let i = orphanTerminals.length - 1; i >= 0; i--) {
                if (accepted.has(orphanTerminals[i]?.runId ?? ""))
                    orphanTerminals.splice(i, 1);
            }
            for (const entry of registry.values()) {
                entry.terminals = entry.terminals.filter((t) => !accepted.has(t.runId));
            }
            for (const runId of accepted)
                terminalCwd.delete(runId);
            let allClosed = true;
            for (const runId of ack.closedRunIds) {
                const entry = [...registry.values()].find((candidate) => candidate.activeRun?.runId === runId);
                const run = entry?.activeRun;
                if (!entry || !run)
                    continue;
                const response = await requestViaWorker(entry, run.projectKey, {
                    requestId: (0, node_crypto_1.randomUUID)(),
                    action: "agent.abort",
                    jobId: run.jobId,
                    runId: run.runId,
                    sessionId: run.sessionId,
                }, REQUEST_TIMEOUT_MS);
                if (response.ok) {
                    if (entry.activeRun === run)
                        entry.activeRun = null;
                }
                else {
                    allClosed = false;
                }
            }
            return { allClosed };
        },
        onEvent(listener) {
            eventListeners.push(listener);
            return () => {
                const i = eventListeners.indexOf(listener);
                if (i !== -1)
                    eventListeners.splice(i, 1);
            };
        },
        async shutdown() {
            for (const entry of registry.values()) {
                entry.handle.send({ type: "shutdown" });
            }
            registry.clear();
        },
    };
}
function isDialogKind(kind) {
    return (kind === "select" ||
        kind === "confirm" ||
        kind === "input" ||
        kind === "editor");
}
/** 组装 PiEvent 包装（供 bridge 转发） */
function wrapPiEvent(clientId, sessionId, jobId, runId, event) {
    return { clientId, sessionId, jobId, runId, event };
}
