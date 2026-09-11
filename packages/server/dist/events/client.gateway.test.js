"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_gateway_js_1 = require("./client.gateway.js");
function makeSocket(id = "socket-1") {
    return {
        id,
        data: {},
        join: vitest_1.vi.fn(),
        emit: vitest_1.vi.fn(),
    };
}
function makeReconciliation(overrides = {}) {
    return {
        handleState: vitest_1.vi.fn(async () => ({
            connectionGeneration: "conn-1",
            accepted: true,
            action: "none",
        })),
        handleLocalResult: vitest_1.vi.fn(async () => { }),
        handleLocalFailure: vitest_1.vi.fn(async () => { }),
        disconnect: vitest_1.vi.fn(async () => { }),
        isBusy: vitest_1.vi.fn(() => false),
        assertWritable: vitest_1.vi.fn(),
        bindDispatcher: vitest_1.vi.fn(),
        recoverInterrupted: vitest_1.vi.fn(async () => { }),
        onModuleDestroy: vitest_1.vi.fn(),
        ...overrides,
    };
}
function makeGateway(reconciliation = makeReconciliation()) {
    const clientService = {
        register: vitest_1.vi.fn(async () => { }),
        getClientIdBySocketId: vitest_1.vi.fn(async () => "c1"),
        markOfflineBySocketId: vitest_1.vi.fn(async () => { }),
        expireStaleClients: vitest_1.vi.fn(async () => []),
    };
    const jobService = {
        markDone: vitest_1.vi.fn().mockResolvedValue(null),
        markDisconnected: vitest_1.vi.fn(async () => { }),
    };
    const fileService = {
        confirmUpload: vitest_1.vi.fn().mockResolvedValue({
            key: "aliyun-file-id",
            size: 158601385,
        }),
    };
    const frpService = {
        settleClientOperation: vitest_1.vi.fn(),
        failClientOperation: vitest_1.vi.fn(),
        markInactiveByClientId: vitest_1.vi.fn(async () => { }),
    };
    const piRequests = {
        bindEmitter: vitest_1.vi.fn(),
        request: vitest_1.vi.fn(),
        resolve: vitest_1.vi.fn(),
        disconnect: vitest_1.vi.fn(),
    };
    const piEvents = {
        publish: vitest_1.vi.fn(async () => { }),
        stream: vitest_1.vi.fn(),
    };
    const piRuns = {
        markReconcilePending: vitest_1.vi.fn(async () => { }),
        reconcileGeneration: vitest_1.vi.fn(async () => ({
            acceptedRunIds: [],
            closedRunIds: [],
            reportAgain: false,
        })),
        withReconciledSocket: vitest_1.vi.fn(async (_clientId, _socketId, operation) => operation()),
        disconnectGeneration: vitest_1.vi.fn(async () => true),
    };
    const terminalService = {
        handleClientResponse: vitest_1.vi.fn(async () => { }),
        handleClientOutput: vitest_1.vi.fn(async () => { }),
        handleClientExit: vitest_1.vi.fn(async () => { }),
        handleClientState: vitest_1.vi.fn(async () => ({
            acceptedSessionIds: [],
            closeSessionIds: [],
        })),
        handleClientDisconnect: vitest_1.vi.fn(async () => { }),
        handleClientRegistered: vitest_1.vi.fn(async () => { }),
    };
    const terminalBroker = {
        bindEmitter: vitest_1.vi.fn(),
        disconnect: vitest_1.vi.fn(),
        resolve: vitest_1.vi.fn(),
    };
    const orchestrator = {
        onClientRegistered: vitest_1.vi.fn(),
        onUpdateReady: vitest_1.vi.fn(),
        onUpdateFailed: vitest_1.vi.fn(),
    };
    const updateChannel = {
        bindEmitters: vitest_1.vi.fn(),
    };
    const gateway = new client_gateway_js_1.ClientGateway(clientService, jobService, fileService, frpService, piRequests, piEvents, piRuns, terminalService, terminalBroker, orchestrator, updateChannel, reconciliation);
    const emit = vitest_1.vi.fn();
    const to = vitest_1.vi.fn(() => ({ emit }));
    gateway.server = { emit: vitest_1.vi.fn(), to };
    return {
        gateway,
        clientService,
        jobService,
        fileService,
        frpService,
        piRequests,
        piEvents,
        piRuns,
        terminalService,
        terminalBroker,
        orchestrator,
        updateChannel,
        reconciliation,
        emit,
        to,
    };
}
const report = { clientId: "c1", runs: [] };
const event = {
    clientId: "c1",
    sessionId: "s1",
    jobId: "s1",
    runId: "r1",
    event: { type: "agent_start", sessionId: "s1" },
};
(0, vitest_1.describe)("ClientGateway client liveness", () => {
    (0, vitest_1.it)("Gateway 初始化后每 5 秒扫描一次心跳超时", async () => {
        const { gateway, clientService } = makeGateway();
        vitest_1.vi.useFakeTimers();
        try {
            gateway.onModuleInit();
            await vitest_1.vi.advanceTimersByTimeAsync(5_000);
            (0, vitest_1.expect)(clientService.expireStaleClients).toHaveBeenCalledTimes(1);
        }
        finally {
            gateway.onModuleDestroy();
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)("未注册 Socket 断开时也释放 broker pending 请求", async () => {
        const { gateway, piRequests, terminalBroker } = makeGateway();
        await gateway.handleDisconnect(makeSocket());
        (0, vitest_1.expect)(piRequests.disconnect).toHaveBeenCalledWith("socket-1");
        (0, vitest_1.expect)(terminalBroker.disconnect).toHaveBeenCalledWith("socket-1");
    });
    (0, vitest_1.it)("心跳超时后按 socket lease 执行断线清理", async () => {
        const { gateway, clientService, piRuns, jobService, frpService, terminalService, } = makeGateway();
        clientService.expireStaleClients.mockResolvedValue([
            { clientId: "c1", socketId: "socket-1" },
        ]);
        await gateway.sweepStaleClients();
        (0, vitest_1.expect)(piRuns.disconnectGeneration).toHaveBeenCalledWith("c1", "socket-1");
        (0, vitest_1.expect)(jobService.markDisconnected).toHaveBeenCalledWith("c1");
        (0, vitest_1.expect)(frpService.markInactiveByClientId).toHaveBeenCalledWith("c1");
        (0, vitest_1.expect)(terminalService.handleClientDisconnect).toHaveBeenCalledWith("c1", "socket-1");
    });
});
(0, vitest_1.describe)("ClientGateway Pi generation routing", () => {
    (0, vitest_1.it)("afterInit 精确投递 socketId，不使用 clientId room", () => {
        const { gateway, piRequests, to, emit } = makeGateway();
        gateway.afterInit();
        const binder = piRequests.bindEmitter.mock.calls[0]?.[0];
        binder("socket-2", { requestId: "r1", action: "sessions.list" });
        (0, vitest_1.expect)(to).toHaveBeenCalledWith("socket-2");
        (0, vitest_1.expect)(emit).toHaveBeenCalledWith("pi:request", vitest_1.expect.objectContaining({ requestId: "r1" }));
    });
    (0, vitest_1.it)("REGISTER 在 ack 前绑定身份并进入 pending generation", async () => {
        const { gateway, piRuns } = makeGateway();
        const socket = makeSocket();
        const order = [];
        piRuns.markReconcilePending.mockImplementation(async () => {
            order.push("pending");
        });
        await gateway.handleRegister(socket, {
            clientId: "c1",
            hostname: "host",
            os: "win32",
            cpuModel: "cpu",
            totalMemMB: 1024,
            clientVersion: "1",
            capabilities: ["agent.pi"],
            capabilityDetails: {},
        });
        (0, vitest_1.expect)(socket.data.clientId).toBe("c1");
        (0, vitest_1.expect)(piRuns.markReconcilePending).toHaveBeenCalledWith("c1", "socket-1");
        (0, vitest_1.expect)(order).toEqual(["pending"]);
    });
    (0, vitest_1.it)("REGISTER 含新字段（privileged + installation）时正常持久化", async () => {
        const { gateway, clientService } = makeGateway();
        const socket = makeSocket();
        await gateway.handleRegister(socket, {
            clientId: "c1",
            hostname: "host",
            os: "linux 6.11.0",
            cpuModel: "cpu",
            totalMemMB: 1024,
            clientVersion: "1",
            capabilities: ["exec"],
            capabilityDetails: {
                privileged: {
                    available: true,
                    mode: "sudo-all",
                    nonInteractive: true,
                    runAsUser: "vcpdeck",
                },
            },
            installation: { mode: "systemd-root-equivalent" },
        });
        (0, vitest_1.expect)(clientService.register).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            installation: { mode: "systemd-root-equivalent" },
        }), "socket-1");
    });
    (0, vitest_1.it)("非法 REGISTER（缺 hostname / 非法 privileged mode）不持久化并断开", async () => {
        const { gateway, clientService } = makeGateway();
        const socket = makeSocket();
        socket.disconnect = vitest_1.vi.fn();
        await gateway.handleRegister(socket, {
            clientId: "c1",
            os: "win32",
            cpuModel: "cpu",
            totalMemMB: 1024,
            clientVersion: "1",
            capabilities: ["exec"],
        });
        (0, vitest_1.expect)(clientService.register).not.toHaveBeenCalled();
        (0, vitest_1.expect)(socket.data.clientId).toBeUndefined();
        (0, vitest_1.expect)(socket.disconnect).toHaveBeenCalled();
        const socket2 = makeSocket("socket-2");
        socket2.disconnect = vitest_1.vi.fn();
        await gateway.handleRegister(socket2, {
            clientId: "c1",
            hostname: "host",
            os: "win32",
            cpuModel: "cpu",
            totalMemMB: 1024,
            clientVersion: "1",
            capabilities: ["exec"],
            capabilityDetails: { privileged: { available: true, mode: "root" } },
        });
        (0, vitest_1.expect)(socket2.disconnect).toHaveBeenCalled();
    });
    (0, vitest_1.it)("PI_STATE 只经 reconcileGeneration 并原样 ack", async () => {
        const { gateway, piRuns, piEvents } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        const expected = {
            acceptedRunIds: ["run-idle"],
            closedRunIds: ["run-stale"],
            reportAgain: true,
        };
        piRuns.reconcileGeneration.mockResolvedValue(expected);
        const result = await gateway.handlePiState(socket, report);
        (0, vitest_1.expect)(piRuns.reconcileGeneration).toHaveBeenCalledWith("c1", "socket-1", report);
        (0, vitest_1.expect)(result).toEqual(expected);
        (0, vitest_1.expect)(piEvents).not.toHaveProperty("handleState");
    });
    (0, vitest_1.it)("PI_RESPONSE 直接按响应 socket resolve，不查 DB socketId", async () => {
        const { gateway, piRequests, clientService } = makeGateway();
        const socket = makeSocket("old-socket");
        socket.data.clientId = "c1";
        const response = { requestId: "r1", ok: true, data: {} };
        await gateway.handlePiResponse(socket, response);
        (0, vitest_1.expect)(piRequests.resolve).toHaveBeenCalledWith("old-socket", response);
        (0, vitest_1.expect)(clientService.getClientIdBySocketId).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("旧 socket 的迟到 PI_EVENT 不进入状态机", async () => {
        const { gateway, piRuns, piEvents } = makeGateway();
        const socket = makeSocket("old-socket");
        socket.data.clientId = "c1";
        piRuns.withReconciledSocket.mockRejectedValue(Object.assign(new Error("stale"), { code: "PI_STATE_PENDING" }));
        await gateway.handlePiEvent(socket, event);
        (0, vitest_1.expect)(piEvents.publish).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("断线先失败 socket pending request，再处理 matching generation", async () => {
        const { gateway, piRequests, piRuns } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        const order = [];
        piRequests.disconnect.mockImplementation(() => {
            order.push("request-disconnected");
        });
        piRuns.disconnectGeneration.mockImplementation(async () => {
            order.push("generation-disconnected");
            return true;
        });
        await gateway.handleDisconnect(socket);
        (0, vitest_1.expect)(piRequests.disconnect).toHaveBeenCalledWith("socket-1");
        (0, vitest_1.expect)(piRuns.disconnectGeneration).toHaveBeenCalledWith("c1", "socket-1");
        (0, vitest_1.expect)(order).toEqual(["request-disconnected", "generation-disconnected"]);
    });
});
(0, vitest_1.describe)("ClientGateway terminal routing", () => {
    (0, vitest_1.it)("afterInit 绑定 terminal emitter 精确投递 socketId", () => {
        const { gateway, terminalBroker, emit } = makeGateway();
        gateway.afterInit();
        // 第二个 bindEmitter 调用属于 terminal broker
        const binder = terminalBroker.bindEmitter.mock.calls[0]?.[0];
        if (!binder)
            throw new Error("no binder");
        binder("socket-2", { requestId: "r1", action: "shells.list" });
        (0, vitest_1.expect)(emit).toHaveBeenCalledWith("terminal:request", vitest_1.expect.objectContaining({ requestId: "r1" }));
    });
    (0, vitest_1.it)("未 REGISTER 的 socket 上报 terminal 消息被忽略", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        await gateway.handleTerminalResponse(socket, {
            requestId: "r1",
            ok: true,
            action: "session.detach",
            sessionId: "s1",
        });
        await gateway.handleTerminalOutput(socket, {
            sessionId: "s1",
            seq: 1,
            data: "x",
        });
        await gateway.handleTerminalExit(socket, { sessionId: "s1", exitCode: 0 });
        (0, vitest_1.expect)(terminalService.handleClientResponse).not.toHaveBeenCalled();
        (0, vitest_1.expect)(terminalService.handleClientOutput).not.toHaveBeenCalled();
        (0, vitest_1.expect)(terminalService.handleClientExit).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("TERMINAL_RESPONSE 解析后按 socket 绑定 clientId 交给 service", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket("socket-9");
        socket.data.clientId = "c1";
        await gateway.handleTerminalResponse(socket, {
            requestId: "r1",
            ok: true,
            action: "session.detach",
            sessionId: "s1",
        });
        (0, vitest_1.expect)(terminalService.handleClientResponse).toHaveBeenCalledWith("c1", "socket-9", vitest_1.expect.objectContaining({ requestId: "r1" }));
    });
    (0, vitest_1.it)("非法 TERMINAL_RESPONSE 被忽略", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        await gateway.handleTerminalResponse(socket, {
            requestId: "r1",
            ok: true,
            action: "session.hack",
            sessionId: "s1",
        });
        (0, vitest_1.expect)(terminalService.handleClientResponse).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("TERMINAL_OUTPUT 解析后交给 service（身份来自 socket 绑定）", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        await gateway.handleTerminalOutput(socket, {
            sessionId: "s1",
            seq: 3,
            data: "ok",
        });
        (0, vitest_1.expect)(terminalService.handleClientOutput).toHaveBeenCalledWith("c1", {
            sessionId: "s1",
            seq: 3,
            data: "ok",
        });
    });
    (0, vitest_1.it)("TERMINAL_EXIT 解析后交给 service", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        await gateway.handleTerminalExit(socket, { sessionId: "s1", exitCode: 0 });
        (0, vitest_1.expect)(terminalService.handleClientExit).toHaveBeenCalledWith("c1", {
            sessionId: "s1",
            exitCode: 0,
        });
    });
    (0, vitest_1.it)("TERMINAL_STATE 解析后交给 service 并原样 ack", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        const report = { clientId: "c1", generationId: "g1", sessions: [] };
        terminalService.handleClientState.mockResolvedValue({
            acceptedSessionIds: ["s1"],
            closeSessionIds: ["s2"],
        });
        const result = await gateway.handleTerminalState(socket, report);
        (0, vitest_1.expect)(terminalService.handleClientState).toHaveBeenCalledWith("c1", "socket-1", report);
        (0, vitest_1.expect)(result).toEqual({
            acceptedSessionIds: ["s1"],
            closeSessionIds: ["s2"],
        });
    });
    (0, vitest_1.it)("非法 TERMINAL_STATE 不 ack", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        const result = await gateway.handleTerminalState(socket, {
            clientId: 42,
            generationId: "g",
            sessions: [],
        });
        (0, vitest_1.expect)(terminalService.handleClientState).not.toHaveBeenCalled();
        (0, vitest_1.expect)(result).toEqual({ acceptedSessionIds: [], closeSessionIds: [] });
    });
    (0, vitest_1.it)("断线通知 terminal service 但不终结会话", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        await gateway.handleDisconnect(socket);
        (0, vitest_1.expect)(terminalService.handleClientDisconnect).toHaveBeenCalledWith("c1", "socket-1");
        (0, vitest_1.expect)(terminalService.handleClientOutput).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("REGISTER 成功后通知 terminal service", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        await gateway.handleRegister(socket, {
            clientId: "c1",
            hostname: "host",
            os: "win32",
            cpuModel: "cpu",
            totalMemMB: 1024,
            clientVersion: "1",
            capabilities: [],
        });
        (0, vitest_1.expect)(terminalService.handleClientRegistered).toHaveBeenCalledWith("c1", "socket-1");
    });
});
(0, vitest_1.describe)("ClientGateway.handleJobDone", () => {
    (0, vitest_1.it)("exec 基础设施错误保留输出并继续派发队列", async () => {
        const { gateway, jobService, emit } = makeGateway();
        jobService.markDone.mockResolvedValue({
            jobId: "next-job",
            clientId: "c1",
            type: "exec",
            payload: { mode: "command", command: "echo next" },
            timeout: null,
        });
        await gateway.handleJobDone({
            jobId: "job-1",
            type: "exec",
            error: { code: "EXEC_TIMEOUT", message: "Execution timed out" },
            stdout: "READY\n",
        });
        (0, vitest_1.expect)(jobService.markDone).toHaveBeenCalledWith("job-1", "exec", {
            errorCode: "EXEC_TIMEOUT",
            errorMessage: "Execution timed out",
            stdout: "READY\n",
        });
        (0, vitest_1.expect)(emit).toHaveBeenCalledWith("job:dispatch", vitest_1.expect.objectContaining({ jobId: "next-job" }));
    });
    (0, vitest_1.it)("FRP Dashboard 收敛成功后才终结 Job", async () => {
        const { gateway, jobService, frpService } = makeGateway();
        frpService.settleClientOperation.mockResolvedValue({
            terminal: true,
            result: { mappingId: "fm_1", status: "active" },
        });
        await gateway.handleJobDone({
            jobId: "job-1",
            type: "frp.create",
            result: { mappingId: "fm_1", status: "active" },
        });
        (0, vitest_1.expect)(frpService.settleClientOperation).toHaveBeenCalledWith("job-1", "frp.create");
        (0, vitest_1.expect)(jobService.markDone).toHaveBeenCalledWith("job-1", "frp.create", {
            mappingId: "fm_1",
            status: "active",
        });
    });
    (0, vitest_1.it)("创建超时派发回滚且不提前终结创建 Job", async () => {
        const { gateway, jobService, frpService, emit } = makeGateway();
        frpService.settleClientOperation.mockResolvedValue({
            terminal: false,
            dispatch: {
                jobId: "rollback-job",
                clientId: "c1",
                type: "frp.delete",
                payload: { mappingId: "fm_1", name: "tcp-1919" },
            },
        });
        await gateway.handleJobDone({
            jobId: "job-1",
            type: "frp.create",
            result: { mappingId: "fm_1", status: "active" },
        });
        (0, vitest_1.expect)(jobService.markDone).not.toHaveBeenCalled();
        (0, vitest_1.expect)(emit).toHaveBeenCalledWith("job:dispatch", vitest_1.expect.objectContaining({ jobId: "rollback-job", type: "frp.delete" }));
    });
    (0, vitest_1.it)("回滚终态同时终结原创建 Job", async () => {
        const { gateway, jobService, frpService } = makeGateway();
        frpService.settleClientOperation.mockResolvedValue({
            terminal: true,
            result: { mappingId: "fm_1", deleted: true },
            relatedJob: {
                jobId: "create-job",
                errorCode: "FRP_PROXY_CONFIRM_TIMEOUT",
                errorMessage: "已自动回滚",
            },
        });
        await gateway.handleJobDone({
            jobId: "rollback-job",
            type: "frp.delete",
            result: { mappingId: "fm_1", deleted: true },
        });
        (0, vitest_1.expect)(jobService.markDone).toHaveBeenCalledWith("create-job", "frp.create", vitest_1.expect.objectContaining({
            errorCode: "FRP_PROXY_CONFIRM_TIMEOUT",
        }));
    });
    (0, vitest_1.it)("FRP Client 失败进入服务收敛，不走通用立即终态", async () => {
        const { gateway, jobService, frpService } = makeGateway();
        frpService.failClientOperation.mockResolvedValue({
            terminal: false,
            dispatch: {
                jobId: "rollback-job",
                clientId: "c1",
                type: "frp.delete",
                payload: { mappingId: "fm_1", name: "tcp-1919" },
            },
        });
        await gateway.handleJobDone({
            jobId: "create-job",
            type: "frp.create",
            error: { code: "FRPC_START_FAILED", message: "frpc 启动失败" },
        });
        (0, vitest_1.expect)(frpService.failClientOperation).toHaveBeenCalledWith("create-job", "frp.create", "FRPC_START_FAILED", "frpc 启动失败");
        (0, vitest_1.expect)(jobService.markDone).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("用数据库中的真实 key 覆盖 Client 回传的临时 key", async () => {
        const { gateway, jobService, fileService } = makeGateway();
        const result = {
            fileId: "file-1",
            key: "temporary-key/nginx-1.18.0.zip",
            sha256: "sha256-value",
            size: 158601385,
        };
        await gateway.handleJobDone({
            jobId: "job-1",
            type: "file.export",
            result,
        });
        (0, vitest_1.expect)(fileService.confirmUpload).toHaveBeenCalledWith("file-1", "sha256-value");
        (0, vitest_1.expect)(jobService.markDone).toHaveBeenCalledWith("job-1", "file.export", {
            ...result,
            key: "aliyun-file-id",
        });
    });
});
(0, vitest_1.describe)("ClientGateway FRP reconciliation", () => {
    const validStateReport = {
        clientId: "c1",
        connectionGeneration: "conn-1",
        runtimeGeneration: 3,
        status: "running",
        processRunning: true,
        recoveryOwner: null,
        attempt: 0,
        frpsEndpoint: { serverAddr: "frps.example.com", serverPort: 7000 },
        mappings: [
            {
                mappingId: "fm_1",
                name: "tcp-1919",
                proxyType: "tcp",
                localIp: "127.0.0.1",
                localPort: 1919,
                remotePort: 20000,
                customDomain: null,
            },
        ],
    };
    (0, vitest_1.it)("FRP_STATE 只把已注册 socket 与严格 report 交给 reconciliation service 并 ack", async () => {
        const { gateway, reconciliation, to } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        const ack = await gateway.handleFrpState(socket, validStateReport);
        (0, vitest_1.expect)(reconciliation.handleState).toHaveBeenCalledWith("c1", "socket-1", validStateReport);
        (0, vitest_1.expect)(ack).toMatchObject({ accepted: true });
        (0, vitest_1.expect)(to).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("未注册 socket 的 FRP_STATE 上报失败关闭，不调用 service", async () => {
        const { gateway, reconciliation } = makeGateway();
        const socket = makeSocket();
        const ack = await gateway.handleFrpState(socket, validStateReport);
        (0, vitest_1.expect)(reconciliation.handleState).not.toHaveBeenCalled();
        (0, vitest_1.expect)(ack).toMatchObject({ accepted: false, action: "stale" });
    });
    (0, vitest_1.it)("reconcile dispatch 精确发往 socketId，不使用 clientId room", () => {
        const { gateway, reconciliation, to, emit } = makeGateway();
        gateway.afterInit();
        const dispatcher = reconciliation.bindDispatcher.mock.calls[0]?.[0];
        (0, vitest_1.expect)(typeof dispatcher).toBe("function");
        const emitJobDispatch = vitest_1.vi.fn();
        const emitJobUpdate = vitest_1.vi.fn();
        const toMock = vitest_1.vi.fn(() => ({
            emit: (event, payload) => {
                if (event === "job:dispatch")
                    emitJobDispatch(payload);
            },
        }));
        gateway.server.to = toMock;
        const originalEmit = gateway.server.emit;
        gateway.server.emit = (event, payload) => {
            if (event === "job:update")
                emitJobUpdate(payload);
            return originalEmit?.(event, payload);
        };
        dispatcher("socket-2", {
            jobId: "reconcile-1",
            clientId: "c1",
            type: "frp.reconcile",
            payload: { connectionGeneration: "conn-1" },
            timeout: 30,
        });
        (0, vitest_1.expect)(toMock).toHaveBeenCalledWith("socket-2");
        (0, vitest_1.expect)(emitJobDispatch).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ jobId: "reconcile-1", type: "frp.reconcile" }));
        (0, vitest_1.expect)(emitJobUpdate).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ jobId: "reconcile-1", status: "running" }));
    });
    (0, vitest_1.it)("frp.reconcile JOB_DONE 交给 reconciliation service，不走 create rollback", async () => {
        const { gateway, reconciliation, frpService, emit } = makeGateway();
        await gateway.handleJobDone({
            jobId: "reconcile-1",
            type: "frp.reconcile",
            result: {
                connectionGeneration: "conn-1",
                runtimeGeneration: 4,
                status: "running",
                loadedMappingIds: ["fm_1"],
            },
        });
        (0, vitest_1.expect)(reconciliation.handleLocalResult).toHaveBeenCalledWith("reconcile-1", vitest_1.expect.objectContaining({ runtimeGeneration: 4 }));
        (0, vitest_1.expect)(frpService.settleClientOperation).not.toHaveBeenCalled();
        (0, vitest_1.expect)(frpService.failClientOperation).not.toHaveBeenCalled();
        (0, vitest_1.expect)(emit).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("frp.reconcile JOB_DONE error 交给 reconciliation service 安全错误码", async () => {
        const { gateway, reconciliation, frpService } = makeGateway();
        await gateway.handleJobDone({
            jobId: "reconcile-1",
            type: "frp.reconcile",
            error: { code: "FRPC_START_FAILED", message: "frpc 启动失败" },
        });
        (0, vitest_1.expect)(reconciliation.handleLocalFailure).toHaveBeenCalledWith("reconcile-1", "FRPC_START_FAILED");
        (0, vitest_1.expect)(frpService.failClientOperation).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("断线总是通知 reconciliation service（匹配 socket 由其内部判断）", async () => {
        const { gateway, reconciliation, clientService } = makeGateway();
        const socket = makeSocket();
        socket.data.clientId = "c1";
        await gateway.handleDisconnect(socket);
        (0, vitest_1.expect)(reconciliation.disconnect).toHaveBeenCalledWith("c1", "socket-1");
        (0, vitest_1.expect)(clientService.markOfflineBySocketId).toHaveBeenCalledWith("socket-1");
    });
    (0, vitest_1.it)("心跳超时 sweep 也通知 reconciliation service", async () => {
        const { gateway, clientService, reconciliation } = makeGateway();
        clientService.expireStaleClients.mockResolvedValue([
            { clientId: "c1", socketId: "socket-7" },
        ]);
        await gateway.sweepStaleClients();
        (0, vitest_1.expect)(reconciliation.disconnect).toHaveBeenCalledWith("c1", "socket-7");
    });
});
