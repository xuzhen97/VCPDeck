"use strict";
/** @file FRP Runtime Manager — 管理完整映射快照、frpc 生命周期与在线崩溃有限重启 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFrpRuntimeManager = createFrpRuntimeManager;
function createFrpRuntimeManager(deps) {
    let currentChild = null;
    let runtimeGeneration = 0;
    let connectionGeneration = null;
    const clientId = deps.clientId ?? "";
    let frpsInfo = null;
    let proxies = [];
    let status = "stopped";
    let processRunning = false;
    let recoveryOwner = null;
    let attempt = 0;
    /** 已排定的 Client 自愈重启次数（0–3；3 次耗尽后置 failed）。 */
    let retryCount = 0;
    let retryTimer = null;
    /** 健康观察窗：frpc 存活超过该窗口才重置重试预算（spawn 成功不等于 FRPS 可达）。 */
    let healthTimer = null;
    const HEALTH_GRACE_MS = 10_000;
    let shuttingDown = false;
    const listeners = new Set();
    function getStateReport(clientId) {
        return {
            clientId,
            connectionGeneration: connectionGeneration ?? "",
            runtimeGeneration,
            status,
            processRunning,
            recoveryOwner,
            attempt,
            frpsEndpoint: frpsInfo
                ? { serverAddr: frpsInfo.serverAddr, serverPort: frpsInfo.serverPort }
                : null,
            mappings: proxies.map(toSnapshot),
        };
    }
    function toSnapshot(p) {
        return {
            mappingId: p.mappingId,
            name: p.name,
            proxyType: p.type,
            localIp: p.localIP,
            localPort: p.localPort,
            remotePort: p.remotePort ?? null,
            customDomain: p.customDomain ?? null,
        };
    }
    function emitState() {
        const report = getStateReport(clientId);
        deps.onState(report);
        for (const listener of listeners) {
            listener(report);
        }
    }
    function clearRetryTimer() {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    }
    function clearHealthTimer() {
        if (healthTimer) {
            clearTimeout(healthTimer);
            healthTimer = null;
        }
    }
    function armHealthGrace() {
        clearHealthTimer();
        healthTimer = setTimeout(() => {
            healthTimer = null;
            if (shuttingDown || !processRunning)
                return;
            // frpc 稳定存活：本轮自愈有效，重置有限重试预算。
            retryCount = 0;
        }, HEALTH_GRACE_MS);
    }
    function buildConfigContent(frps, proxyList) {
        const proxyBlocks = proxyList.map((p) => {
            const lines = [
                "[[proxies]]",
                `name = "${p.name}"`,
                `type = "${p.type}"`,
                `localIP = "${p.localIP}"`,
                `localPort = ${p.localPort}`,
            ];
            if (typeof p.remotePort === "number" && p.type === "tcp") {
                lines.push(`remotePort = ${p.remotePort}`);
            }
            if (p.customDomain) {
                lines.push(`customDomains = ["${p.customDomain}"]`);
            }
            return lines.join("\n");
        });
        return [
            `serverAddr = "${frps.serverAddr}"`,
            `serverPort = ${frps.serverPort}`,
            "",
            `auth.method = "token"`,
            `auth.token = "${frps.authToken}"`,
            "",
            ...proxyBlocks,
        ].join("\n") + "\n";
    }
    function startFrpc(frps, proxyList) {
        const frpcPath = deps.resolveExecutable();
        if (!frpcPath)
            return Promise.reject(new Error("frpc 二进制不存在"));
        // 计划内替换：先终止旧 frpc；旧 child 的 exit 由身份校验忽略，不触发异常重试。
        if (currentChild && !shuttingDown) {
            try {
                currentChild.kill("SIGTERM");
            }
            catch {
                // 进程已退出
            }
        }
        clearHealthTimer();
        const content = buildConfigContent(frps, proxyList);
        deps.writeConfigAtomically(content);
        const child = deps.spawn(frpcPath, ["-c", "frpc-combined.toml"], {
            cwd: deps.workDir,
            stdio: "pipe",
            windowsHide: true,
        });
        currentChild = child;
        // frpc 的运行时日志与错误（含配置缺失）默认写 stdout；两路都进安全日志（frp 不回显 token）。
        child.stdout?.on("data", (data) => {
            deps.log(`[frpc] ${data.toString().trim()}`);
        });
        child.stderr?.on("data", (data) => {
            deps.log(`[frpc] ${data.toString().trim()}`);
        });
        child.on("exit", (code) => {
            if (currentChild !== child)
                return;
            currentChild = null;
            processRunning = false;
            clearHealthTimer();
            deps.log(`[frpc] 已退出 (code ${code})`);
            if (!shuttingDown && frpsInfo && proxies.length > 0 && !retryTimer) {
                scheduleClientRetry();
            }
        });
        return new Promise((resolve, reject) => {
            let settled = false;
            child.once("spawn", () => {
                if (settled)
                    return;
                settled = true;
                processRunning = true;
                resolve();
            });
            child.once("error", () => {
                if (settled)
                    return;
                settled = true;
                if (currentChild === child) {
                    currentChild = null;
                    processRunning = false;
                }
                reject(new Error("frpc 启动失败"));
            });
        });
    }
    /** 在线崩溃的 Client 独占有限重启：delay 0/5s/30s 共三次，耗尽后置 failed。 */
    function scheduleClientRetry() {
        if (shuttingDown || !frpsInfo || proxies.length === 0)
            return;
        if (retryCount >= 3) {
            status = "failed";
            recoveryOwner = "client";
            emitState();
            return;
        }
        const delay = deps.delays[retryCount];
        retryCount += 1;
        attempt = Math.min(retryCount, 2);
        status = "retrying";
        recoveryOwner = "client";
        emitState();
        clearRetryTimer();
        retryTimer = setTimeout(async () => {
            retryTimer = null;
            if (shuttingDown)
                return;
            try {
                await startFrpc(frpsInfo, proxies);
                status = "running";
                attempt = 0;
                // 不在 spawn 时重置预算：frpc 可能因 FRPS 不可达立即退出；
                // 只有健康观察窗确认稳定存活后才重置，防止 0ms 无限自愈循环。
                recoveryOwner = null;
                emitState();
                armHealthGrace();
            }
            catch {
                deps.log("[frp-runtime] frpc 自愈重启失败，排定下一次有限重启");
                scheduleClientRetry();
            }
        }, delay);
    }
    async function reconcile(payload) {
        if (connectionGeneration && payload.connectionGeneration !== connectionGeneration) {
            const err = new Error("FRP_RUNTIME_GENERATION_STALE");
            err.code = "FRP_RUNTIME_GENERATION_STALE";
            throw err;
        }
        // 接受即绑定本代 connection generation；旧代 payload 在重连后被上面的守卫拒绝。
        connectionGeneration = payload.connectionGeneration;
        // 权威组与保留组的 mappingId/name 不得冲突（Server 保证，Client 防御性拒绝）。
        const seen = new Set();
        for (const m of [...payload.mappings, ...payload.preservedMappings]) {
            const key = `${m.name}@${m.localPort}:${m.remotePort ?? ""}`;
            if (seen.has(key)) {
                const err = new Error("FRP_RUNTIME_STATE_INVALID");
                err.code = "FRP_RUNTIME_STATE_INVALID";
                throw err;
            }
            seen.add(key);
        }
        const previousProxies = [...proxies];
        const previousFrpsInfo = frpsInfo;
        const newProxies = [
            ...payload.mappings.map(toProxy),
            ...payload.preservedMappings.map(toProxy),
        ];
        try {
            frpsInfo = { ...payload.frpsInfo };
            proxies = newProxies;
            status = "starting";
            processRunning = false;
            recoveryOwner = null;
            attempt = 0;
            retryCount = 0;
            clearRetryTimer();
            await startFrpc(payload.frpsInfo, newProxies);
            runtimeGeneration = payload.expectedRuntimeGeneration;
            status = "running";
            emitState();
            return {
                connectionGeneration: payload.connectionGeneration,
                runtimeGeneration,
                status: "running",
                loadedMappingIds: payload.mappings.map((m) => m.mappingId),
            };
        }
        catch (err) {
            // 失败不递增有效 generation；回滚旧 registry/config（非阻塞，Job 快速失败）。
            proxies = previousProxies;
            frpsInfo = previousFrpsInfo;
            status = "stopped";
            processRunning = false;
            recoveryOwner = null;
            clearRetryTimer();
            if (previousFrpsInfo && previousProxies.length > 0) {
                void (async () => {
                    try {
                        await startFrpc(previousFrpsInfo, previousProxies);
                        status = "running";
                        emitState();
                    }
                    catch {
                        deps.log("[frp-runtime] 回滚重启 frpc 失败");
                        status = "stopped";
                        emitState();
                    }
                })();
            }
            throw err;
        }
    }
    function toProxy(m) {
        return {
            mappingId: m.mappingId,
            name: m.name,
            type: m.proxyType,
            localIP: m.localIp,
            localPort: m.localPort,
            remotePort: m.remotePort ?? undefined,
            customDomain: m.customDomain ?? undefined,
        };
    }
    async function create(payload) {
        if (proxies.find((p) => p.mappingId === payload.mappingId)) {
            throw new Error("MAPPING_EXISTS");
        }
        const previousProxies = [...proxies];
        const previousFrpsInfo = frpsInfo;
        const proxy = {
            mappingId: payload.mappingId,
            name: payload.name,
            type: payload.proxyType,
            localIP: payload.localIp,
            localPort: payload.localPort,
            remotePort: payload.remotePort,
            customDomain: payload.customDomain,
        };
        proxies.push(proxy);
        frpsInfo = { ...payload.frpsInfo };
        status = "starting";
        processRunning = false;
        recoveryOwner = null;
        attempt = 0;
        retryCount = 0;
        clearRetryTimer();
        try {
            await startFrpc(payload.frpsInfo, proxies);
            runtimeGeneration += 1;
            status = "running";
            emitState();
            return { mappingId: payload.mappingId, status: "active" };
        }
        catch (err) {
            // 回滚旧 registry/config（阻塞：create Job 需确认回滚后回报安全错误）。
            proxies = previousProxies;
            frpsInfo = previousFrpsInfo;
            status = "stopped";
            processRunning = false;
            if (previousFrpsInfo && previousProxies.length > 0) {
                try {
                    await startFrpc(previousFrpsInfo, previousProxies);
                    status = "running";
                    emitState();
                }
                catch {
                    deps.log("[frp-runtime] create 回滚重启 frpc 失败");
                    status = "stopped";
                    emitState();
                }
            }
            throw err;
        }
    }
    async function remove(payload) {
        const index = proxies.findIndex((p) => p.mappingId === payload.mappingId);
        const removed = index === -1 ? undefined : proxies.splice(index, 1)[0];
        processRunning = false;
        try {
            if (proxies.length === 0) {
                if (currentChild) {
                    try {
                        currentChild.kill("SIGTERM");
                    }
                    catch {
                        // 进程已退出
                    }
                    currentChild = null;
                }
                status = "stopped";
            }
            else if (frpsInfo) {
                await startFrpc(frpsInfo, proxies);
                runtimeGeneration += 1;
                status = "running";
            }
            emitState();
            return { mappingId: payload.mappingId, deleted: true };
        }
        catch (err) {
            // 恢复被删除条目（阻塞：delete Job 需确认恢复后回报安全错误）。
            if (removed)
                proxies.splice(index, 0, removed);
            if (frpsInfo) {
                try {
                    await startFrpc(frpsInfo, proxies);
                    status = "running";
                    emitState();
                }
                catch {
                    deps.log("[frp-runtime] delete 恢复重启 frpc 失败");
                    status = "stopped";
                    emitState();
                }
            }
            throw err;
        }
    }
    function list() {
        return {
            mappings: proxies.map((p) => ({
                id: p.mappingId,
                name: p.name,
                proxyType: p.type,
                localPort: p.localPort,
                remotePort: p.remotePort ?? null,
                status: processRunning ? "active" : "inactive",
            })),
        };
    }
    async function shutdown() {
        // 计划内停机：取消有限重启 timer，防止版本切换/退出被误判为 frpc crash。
        shuttingDown = true;
        clearRetryTimer();
        if (currentChild) {
            try {
                currentChild.kill("SIGTERM");
            }
            catch {
                // 进程已退出
            }
            currentChild = null;
        }
        status = "stopped";
        processRunning = false;
        recoveryOwner = null;
        attempt = 0;
        retryCount = 0;
        emitState();
    }
    return {
        isAvailable: () => deps.resolveExecutable() !== null,
        setConnectionGeneration: (value) => {
            connectionGeneration = value;
        },
        getStateReport,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        reconcile,
        create,
        delete: remove,
        list,
        shutdown,
    };
}
