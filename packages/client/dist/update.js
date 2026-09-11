"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDraining = isDraining;
exports.attachUpdateHandler = attachUpdateHandler;
/**
 * 客户端有界 drain 与 Launcher 两阶段更新处理。
 * 详见 docs/design/release-and-update.md。
 * 收到 update:request 后：
 *   1) 调本机 launcher /prepare（下载/校验/解压）
 *   2) 拒新 job（draining 标志，dispatcher 守卫）
 *   3) 等运行中 job 完成（超时强制继续）
 *   4) 回 update:ready → 调 launcher /apply（launcher 停掉本进程并切换）
 */
const shared_1 = require("@vcpdeck/shared");
const register_js_1 = require("./register.js");
const executor_js_1 = require("./executor.js");
let draining = false;
/** 客户端是否处于更新停机中（dispatcher 据此拒绝新任务） */
function isDraining() {
    return draining;
}
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 注册 update:request 处理；返回解绑函数 */
function attachUpdateHandler(deps) {
    const handler = (req) => {
        void handleUpdateRequest(req, deps);
    };
    deps.socket.on(shared_1.Events.UPDATE_REQUEST, handler);
    return () => {
        deps.socket.off(shared_1.Events.UPDATE_REQUEST, handler);
    };
}
async function handleUpdateRequest(req, deps) {
    if (draining)
        return; // 已在更新流程，忽略重复请求
    const log = deps.log ?? ((msg) => console.log(`[update] ${msg}`));
    if (!req.releaseVersion || !req.url || !req.sha256) {
        emitFailed(deps, req.releaseVersion ?? "unknown", "update:request 缺少字段");
        return;
    }
    draining = true;
    const releaseVersion = req.releaseVersion;
    try {
        // 1) launcher 准备新版本（相对 URL 解析为完整地址）
        const fullUrl = new URL(req.url, deps.serverBase).toString();
        await deps.launcher.prepareUpdate({
            version: releaseVersion,
            url: fullUrl,
            sha256: req.sha256,
        });
        log(`新版本已就绪: ${releaseVersion}`);
        // 2) 优雅停机：等运行中 job 完成（超时强制继续）
        const deadline = Date.now() + (req.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
        const runningIds = deps.getRunningJobIds ?? executor_js_1.getRunningJobIds;
        while (runningIds().length > 0 && Date.now() < deadline) {
            await sleep(deps.pollIntervalMs ?? 500);
        }
        // 3) 就绪回执 → 本地实时资源计划内释放 → launcher 接管
        deps.socket.emit(shared_1.Events.UPDATE_READY, {
            clientId: register_js_1.CLIENT_ID,
            releaseVersion,
        });
        try {
            await deps.beforeApply?.();
        }
        catch {
            log("beforeApply 释放失败（不阻断更新）");
        }
        await deps.launcher.applyUpdate();
        // apply 后本进程应被 launcher 停止；连接被掐断与「进程仍存活」无法
        // 可靠区分，不在此上报失败——终局以重连注册版本为准。
    }
    catch (e) {
        emitFailed(deps, releaseVersion, e instanceof Error ? e.message : String(e));
    }
    finally {
        draining = false;
    }
}
function emitFailed(deps, releaseVersion, reason) {
    deps.socket.emit(shared_1.Events.UPDATE_FAILED, {
        clientId: register_js_1.CLIENT_ID,
        releaseVersion,
        reason,
    });
}
