/** @file FRP Socket 桥 — 注册确认后上报安全 runtime 快照，严格解析状态确认并忽略旧代次 */

import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io-client";
import {
	Events,
	parseFrpRuntimeStateAck,
	type FrpRuntimeStateAck,
	type FrpRuntimeStateReport,
} from "@vcpdeck/shared";
import type { FrpRuntimeManager } from "./frp-runtime-manager.js";

/** FRP socket 桥依赖。 */
export interface FrpSocketBridgeDeps {
	clientId: string;
	manager: FrpRuntimeManager;
	/** 连接代次工厂（测试注入；缺省生成 UUID）。 */
	createGeneration?: () => string;
}

export interface FrpSocketBridge {
	/** socket connect 时调用：生成新 connection generation 并交给 manager，但不立即恢复。 */
	onConnected: () => void;
	/** 解绑事件订阅（不清空 manager 受信内存配置）。 */
	dispose: () => void;
}

/**
 * 绑定 FRP Socket 桥：
 * - onConnected 生成新 UUID connection generation；
 * - REGISTER ack（REGISTER 回调或兼容 "ack" 事件）后发送第一次 Events.FRP_STATE；
 * - manager 后续状态变化仅在 socket 已连接且本代次已注册时上报；
 * - ack 回调严格解析 FrpRuntimeStateAck，旧 connection generation 的 ack 忽略。
 */
export function attachFrpSocketBridge(
	socket: Socket,
	deps: FrpSocketBridgeDeps,
): FrpSocketBridge {
	let currentGeneration: string | null = null;
	let registered = false;
	let disposed = false;

	const unsubscribe = deps.manager.subscribe(() => {
		emitStateReport();
	});

	function emitStateReport(): void {
		if (disposed || !socket.connected || !registered || !currentGeneration) return;
		const report: FrpRuntimeStateReport = deps.manager.getStateReport(deps.clientId);
		// 仅上报当前代次的快照（manager 已随 setConnectionGeneration 更新）。
		if (report.connectionGeneration !== currentGeneration) return;
		socket.emit(Events.FRP_STATE, report, (raw: unknown) => handleAck(raw));
	}

	function handleAck(raw: unknown): void {
		let ack: FrpRuntimeStateAck;
		try {
			ack = parseFrpRuntimeStateAck(raw);
		} catch {
			// 非法确认静默忽略（不触发任何恢复动作）。
			return;
		}
		// 旧 connection generation 的 ack 忽略。
		if (!currentGeneration || ack.connectionGeneration !== currentGeneration) return;
		// action 仅作观测：reconcile 由 frp.reconcile Job 驱动，Client 自愈由 manager 独占。
	}

	// 兼容旧 Server：现有 "ack" 事件（Server 在 REGISTER 完成后发出）。
	const onAckEvent = (data: { event?: string }) => {
		if (data?.event === Events.REGISTER) onRegistered();
	};
	// 新 Server 可能另发 FRP_STATE_ACK（与 ack 回调重复；ack 处理幂等）。
	const onStateAckEvent = (raw: unknown) => handleAck(raw);

	function onRegistered(): void {
		if (disposed || !currentGeneration || registered) return;
		registered = true;
		emitStateReport();
	}

	socket.on("ack", onAckEvent as never);
	socket.on(Events.FRP_STATE_ACK, onStateAckEvent as never);

	return {
		onConnected() {
			if (disposed) return;
			// 每次连接生成新代次；旧代次的上报资格与 ack 资格作废。
			currentGeneration = deps.createGeneration?.() ?? randomUUID();
			registered = false;
			deps.manager.setConnectionGeneration(currentGeneration);
		},
		dispose() {
			disposed = true;
			socket.off("ack", onAckEvent as never);
			socket.off(Events.FRP_STATE_ACK, onStateAckEvent as never);
			unsubscribe();
		},
	};
}
