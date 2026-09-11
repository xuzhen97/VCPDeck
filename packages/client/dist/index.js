"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMigrationVerifyOnly = isMigrationVerifyOnly;
exports.attachPiBridge = attachPiBridge;
exports.connect = connect;
const socket_io_client_1 = require("socket.io-client");
const shared_1 = require("@vcpdeck/shared");
const shared_2 = require("@vcpdeck/shared");
const register_js_1 = require("./register.js");
const heartbeat_js_1 = require("./heartbeat.js");
const executor_js_1 = require("./executor.js");
const dispatcher_js_1 = require("./dispatcher.js");
const supervisor_js_1 = require("./pi/supervisor.js");
const capability_js_1 = require("./pi/capability.js");
const privileged_capability_js_1 = require("./privileged-capability.js");
const capability_js_2 = require("./terminal/capability.js");
const shell_discovery_js_1 = require("./terminal/shell-discovery.js");
const terminal_manager_js_1 = require("./terminal/terminal-manager.js");
const protocol_bridge_js_1 = require("./terminal/protocol-bridge.js");
const process_tree_js_1 = require("./terminal/process-tree.js");
const update_js_1 = require("./update.js");
const frpc_daemon_js_1 = require("./frpc-daemon.js");
const frp_socket_bridge_js_1 = require("./frp-socket-bridge.js");
const launcher_control_js_1 = require("./launcher-control.js");
const node_crypto_1 = require("node:crypto");
const node_os_1 = require("node:os");
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
const SERVER_BASE = process.env.VCPDECK_SERVER || "http://localhost:3001";
const SERVER_URL = SERVER_BASE + "/client";
const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";
/**
 * M1 迁移验证专用模式（仅 Linux A2 迁移由安装器设置，全新安装/稳态永不进入）：
 * Client 仍执行 REGISTER 与心跳供 Server 验证身份/版本/安装/特权，
 * 但不挂载任何 operational 处理器（Job dispatch/cancel、Files、Terminal、Pi、FRP），
 * 使迁移失败回退前不产生任何业务副作用。
 */
function isMigrationVerifyOnly(env = process.env) {
    return env.VCPDECK_MIGRATION_VERIFY_ONLY === "1";
}
function main() {
    connect();
}
// Auto-run when executed directly: node dist/index.js
if (require.main === module) {
    main();
}
/** 真实 fork 项目 Worker（cwd 通过 argv 传入） */
function forkProjectWorker(cwd) {
    const child = (0, node_child_process_1.fork)((0, node_path_1.join)(__dirname, "pi", "worker.js"), [cwd], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    return {
        send: (msg) => child.send(msg),
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
/**
 * 绑定 Pi Socket 桥：PI_REQUEST 响应、PI_EVENT 转发、注册后状态上报。
 * Server 完成 register 后通过 ack callback 或现有 "ack" event 通知。
 */
function attachPiBridge(socket, deps, opts = {}) {
    const verifyOnly = opts.verifyOnly === true;
    // 迁移验证模式：不挂载任何 Pi 工作处理器（不下发、不响应、不转发事件）。
    if (!verifyOnly) {
        // 请求响应（信任边界：先 parse 再交给 supervisor）
        socket.on(shared_1.Events.PI_REQUEST, (raw) => {
            try {
                const request = (0, shared_2.parsePiRequest)(raw);
                void deps.supervisor.request(request).then((response) => {
                    if (socket.connected)
                        socket.emit(shared_1.Events.PI_RESPONSE, response);
                });
            }
            catch {
                const requestId = typeof raw === "object" &&
                    raw !== null &&
                    "requestId" in raw &&
                    typeof raw.requestId === "string"
                    ? raw.requestId
                    : "";
                if (socket.connected) {
                    socket.emit(shared_1.Events.PI_RESPONSE, {
                        requestId,
                        ok: false,
                        error: { code: "PI_PROTOCOL_INVALID", message: "Invalid request" },
                    });
                }
            }
        });
        // supervisor 事件转发（断线期间不发送；Worker 继续运行）
        deps.supervisor.onEvent((event) => {
            if (socket.connected)
                socket.emit(shared_1.Events.PI_EVENT, event);
        });
    }
    let connectionGeneration = 0;
    let currentRegistered = null;
    function scheduleControlledReconnect(generation) {
        socket.disconnect();
        setTimeout(() => {
            if (generation === connectionGeneration && !socket.connected)
                socket.connect();
        }, 100);
    }
    function reportState(generation, retry = 0, closureConfirmed = false) {
        if (generation !== connectionGeneration || !socket.connected)
            return;
        socket.emit(shared_1.Events.PI_STATE, deps.supervisor.getStateReport(), async (raw) => {
            if (generation !== connectionGeneration)
                return;
            const ack = {
                acceptedRunIds: raw?.acceptedRunIds ?? [],
                closedRunIds: raw?.closedRunIds ?? [],
                reportAgain: raw?.reportAgain ?? false,
            };
            const { allClosed } = await deps.supervisor.applyStateAck(ack);
            if (generation !== connectionGeneration)
                return;
            if (!ack.reportAgain)
                return;
            if (allClosed && !closureConfirmed)
                reportState(generation, retry, true);
            else if (!allClosed && retry < 2)
                setTimeout(() => reportState(generation, retry + 1), 100);
            else
                scheduleControlledReconnect(generation);
        });
    }
    // 兼容旧 Server：现有 "ack" event，始终绑定当前连接代次
    socket.on("ack", (data) => {
        if (data?.event === shared_1.Events.REGISTER)
            currentRegistered?.();
    });
    return {
        async onConnected() {
            const generation = ++connectionGeneration;
            let reported = false;
            const onRegistered = () => {
                if (generation !== connectionGeneration || reported)
                    return;
                reported = true;
                // 迁移验证模式：只做身份/安全验证，不下发任何工作状态。
                if (verifyOnly)
                    return;
                socket.emit(shared_1.Events.STATUS_REPORT, deps.getStatusReport());
                reportState(generation);
            };
            currentRegistered = onRegistered;
            // probe 最多等待 3 秒：超时降级为无 Pi 能力，不阻塞注册
            const piStatus = await Promise.race([
                deps.getPiStatus(),
                new Promise((resolve) => setTimeout(() => resolve(undefined), 3000)),
            ]).catch(() => undefined);
            const terminalStatus = await deps.getTerminalStatus().catch(() => undefined);
            // 运行时安全摘要：探测超时/失败降级为未报告（deps 内部已包 3s 超时），不阻塞注册。
            const runtimeSecurity = await deps.getRuntimeSecurity().catch(() => undefined);
            if (generation === connectionGeneration)
                socket.emit(shared_1.Events.REGISTER, deps.getRegister(piStatus, terminalStatus, runtimeSecurity), onRegistered);
        },
    };
}
function connect() {
    const socket = (0, socket_io_client_1.io)(SERVER_URL, {
        auth: { psk: PSK },
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 10_000,
    });
    // M1 迁移验证模式：仍注册/心跳，但不挂载任何 operational 处理器。
    const verifyOnly = isMigrationVerifyOnly();
    // 自更新：有界 drain + 本机 Launcher 两阶段更新；apply 前计划内释放 frpc。
    (0, update_js_1.attachUpdateHandler)({
        socket,
        launcher: new launcher_control_js_1.ClientLauncher(),
        serverBase: SERVER_BASE,
        beforeApply: () => (0, frpc_daemon_js_1.shutdownFrpRuntime)(),
    });
    // FRP socket 桥：注册确认后上报安全 runtime 快照（每次连接新代次）。
    const frpBridge = (0, frp_socket_bridge_js_1.attachFrpSocketBridge)(socket, {
        clientId: register_js_1.CLIENT_ID,
        manager: (0, frpc_daemon_js_1.getFrpRuntimeManager)(),
    });
    // 进程级停机（SIGTERM/SIGINT 各一次）：
    // 先 dispose 桥（关闭本代次上报资格）→ 计划内停 frpc（防版本切换误判 crash）→ exit(0)。
    let frpShuttingDown = false;
    for (const signal of ["SIGTERM", "SIGINT"]) {
        process.on(signal, () => {
            if (frpShuttingDown)
                return;
            frpShuttingDown = true;
            frpBridge.dispose();
            void (0, frpc_daemon_js_1.shutdownFrpRuntime)()
                .catch(() => {
                console.error("[frp] 停机释放失败（忽略）");
            })
                .finally(() => process.exit(0));
        });
    }
    const supervisor = (0, supervisor_js_1.createPiSupervisor)({
        clientId: register_js_1.CLIENT_ID,
        forkWorker: forkProjectWorker,
    });
    // ── 终端能力（延迟探测；失败仅禁用 Terminal Tab） ──
    const terminalGenerationId = (0, node_crypto_1.randomUUID)();
    const terminalManager = (0, terminal_manager_js_1.createTerminalManager)({
        shells: [],
        cwd: safeCwd(),
        generationId: terminalGenerationId,
        onOutput: () => undefined,
        onSessionEnded: () => undefined,
        spawnPty: createPtySpawner(),
        killTree: (pid) => (0, process_tree_js_1.killProcessTree)(pid),
    });
    (0, protocol_bridge_js_1.wireManagerToSocket)(socket, terminalManager);
    (0, protocol_bridge_js_1.attachTerminalBridge)(socket, {
        clientId: register_js_1.CLIENT_ID,
        manager: terminalManager,
    });
    // 连接后：探测终端能力并发现 Shell（幂等，不阻塞注册超过 3 秒）
    let terminalReady = null;
    function ensureTerminalReady() {
        if (!terminalReady) {
            terminalReady = (async () => {
                const status = await probeWithTimeout(capability_js_2.probeTerminalCapability).catch(() => undefined);
                if (!status?.available)
                    return;
                const shells = await (0, shell_discovery_js_1.discoverShells)(createShellDiscoveryEnv());
                terminalManager.setShells(shells);
            })();
        }
        return terminalReady;
    }
    // 能力探测统一 3s 上限：原生后端加载异常慢时不得阻塞 REGISTER（超时/失败按不可用降级，由桥内 .catch 兜底）。
    function probeWithTimeout(probe) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                reject(new Error("capability probe timeout"));
            }, 3000);
            timer.unref?.();
            probe()
                .then((value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            })
                .catch((err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }
    const bridge = attachPiBridge(socket, {
        clientId: register_js_1.CLIENT_ID,
        supervisor,
        getPiStatus: () => probeWithTimeout(capability_js_1.probePiCapability),
        getTerminalStatus: () => probeWithTimeout(capability_js_2.probeTerminalCapability),
        // 特权探测仅 Linux；非 Linux 两项均为 undefined → 整体未报告（保持 Windows 原语义）。
        // sudo 探测包统一 3s 超时：超时可视为非交互 sudo 不可用，失败关闭且不阻塞 REGISTER。
        getRuntimeSecurity: () => probeWithTimeout(async () => {
            const privileged = await (0, privileged_capability_js_1.probePrivilegedCapability)();
            const installation = (0, privileged_capability_js_1.detectInstallationInfo)();
            if (privileged === undefined && installation === undefined)
                return undefined;
            const info = {};
            if (privileged !== undefined)
                info.privileged = privileged;
            if (installation !== undefined)
                info.installation = installation;
            return info;
        }),
        getRegister: (piStatus, terminalStatus, runtimeSecurity) => (0, register_js_1.getRegisterInfo)(piStatus, terminalStatus, runtimeSecurity, process.env),
        getStatusReport: () => ({
            clientId: register_js_1.CLIENT_ID,
            jobs: (0, executor_js_1.getStatusReport)(),
        }),
    }, { verifyOnly });
    socket.on("connect", () => {
        console.log(`[vcpdeck] connected as ${register_js_1.CLIENT_ID}${verifyOnly ? "（迁移验证模式）" : ""}`);
        if (!verifyOnly) {
            // FRP 桥同步进入新连接代次（不立即恢复；REGISTER ack 后才上报状态）。
            frpBridge.onConnected();
        }
        void (async () => {
            if (!verifyOnly)
                await ensureTerminalReady();
            await bridge.onConnected();
        })();
    });
    setInterval(() => {
        if (socket.connected) {
            socket.emit(shared_1.Events.HEARTBEAT, (0, heartbeat_js_1.getHeartbeat)((0, executor_js_1.getRunningJobIds)()));
        }
    }, 5_000);
    if (!verifyOnly) {
        socket.on(shared_1.Events.JOB_DISPATCH, (data) => {
            console.log(`[vcpdeck] job dispatch: ${data.jobId} — ${data.type}`);
            (0, dispatcher_js_1.dispatch)(data, socket);
        });
        socket.on(shared_1.Events.JOB_CANCEL, (data) => {
            console.log(`[vcpdeck] job cancel: ${data.jobId}`);
            (0, executor_js_1.killJob)(data.jobId, socket);
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
function safeCwd() {
    try {
        return (0, node_os_1.homedir)();
    }
    catch {
        return process.cwd();
    }
}
/** 真实 Shell 探测环境（生产路径；兼容 MSYS 风格 PATH）。 */
function createShellDiscoveryEnv() {
    const isWin = process.platform === "win32";
    const pathEnv = process.env.PATH ?? "";
    // MSYS/Git Bash 的 PATH 用 ":" 分隔且为虚拟路径；按实际分隔符拆分
    const dirs = pathEnv.includes(";")
        ? pathEnv.split(";").filter(Boolean)
        : pathEnv.split(":").filter(Boolean);
    return {
        platform: process.platform,
        home: (0, node_os_1.homedir)(),
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
                        }
                        catch (error) {
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
                        if (first)
                            return first;
                    }
                }
                catch {
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
            }
            catch {
                return false;
            }
        },
    };
}
/** node-pty spawn 适配器（require 延迟到首次创建会话）。
 * Windows 下优先 useConptyDll（kill 时跳过 conpty_console_list_agent，避免
 * 父进程持有 console 时 AttachConsole 失败）；构建缺少 conpty.dll 时回退默认路径。 */
function createPtySpawner() {
    let ptyModule = null;
    return (opts) => {
        if (!ptyModule) {
            ptyModule = require("@lydell/node-pty");
        }
        const baseOptions = {
            name: opts.name,
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env: opts.env,
        };
        let pty;
        if (process.platform === "win32") {
            try {
                pty = ptyModule.spawn(opts.file, opts.args, {
                    ...baseOptions,
                    useConptyDll: true,
                });
            }
            catch {
                // 无 conpty.dll 的构建：回退默认 ConPTY 路径
                pty = ptyModule.spawn(opts.file, opts.args, baseOptions);
            }
        }
        else {
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
