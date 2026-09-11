"use strict";
/** @file FRP Socket 桥 — 注册确认后上报安全 runtime 快照，严格解析状态确认并忽略旧代次 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachFrpSocketBridge = attachFrpSocketBridge;
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
/**
 * 绑定 FRP Socket 桥：
 * - onConnected 生成新 UUID connection generation；
 * - REGISTER ack（REGISTER 回调或兼容 "ack" 事件）后发送第一次 Events.FRP_STATE；
 * - manager 后续状态变化仅在 socket 已连接且本代次已注册时上报；
 * - ack 回调严格解析 FrpRuntimeStateAck，旧 connection generation 的 ack 忽略。
 */
function attachFrpSocketBridge(socket, deps) {
    let currentGeneration = null;
    let registered = false;
    let disposed = false;
    const unsubscribe = deps.manager.subscribe(() => {
        emitStateReport();
    });
    function emitStateReport() {
        if (disposed || !socket.connected || !registered || !currentGeneration)
            return;
        const report = deps.manager.getStateReport(deps.clientId);
        // 仅上报当前代次的快照（manager 已随 setConnectionGeneration 更新）。
        if (report.connectionGeneration !== currentGeneration)
            return;
        socket.emit(shared_1.Events.FRP_STATE, report, (raw) => handleAck(raw));
    }
    function handleAck(raw) {
        let ack;
        try {
            ack = (0, shared_1.parseFrpRuntimeStateAck)(raw);
        }
        catch {
            // 非法确认静默忽略（不触发任何恢复动作）。
            return;
        }
        // 旧 connection generation 的 ack 忽略。
        if (!currentGeneration || ack.connectionGeneration !== currentGeneration)
            return;
        // action 仅作观测：reconcile 由 frp.reconcile Job 驱动，Client 自愈由 manager 独占。
    }
    // 兼容旧 Server：现有 "ack" 事件（Server 在 REGISTER 完成后发出）。
    const onAckEvent = (data) => {
        if (data?.event === shared_1.Events.REGISTER)
            onRegistered();
    };
    // 新 Server 可能另发 FRP_STATE_ACK（与 ack 回调重复；ack 处理幂等）。
    const onStateAckEvent = (raw) => handleAck(raw);
    function onRegistered() {
        if (disposed || !currentGeneration || registered)
            return;
        registered = true;
        emitStateReport();
    }
    socket.on("ack", onAckEvent);
    socket.on(shared_1.Events.FRP_STATE_ACK, onStateAckEvent);
    return {
        onConnected() {
            if (disposed)
                return;
            // 每次连接生成新代次；旧代次的上报资格与 ack 资格作废。
            currentGeneration = deps.createGeneration?.() ?? (0, node_crypto_1.randomUUID)();
            registered = false;
            deps.manager.setConnectionGeneration(currentGeneration);
        },
        dispose() {
            disposed = true;
            socket.off("ack", onAckEvent);
            socket.off(shared_1.Events.FRP_STATE_ACK, onStateAckEvent);
            unsubscribe();
        },
    };
}
