import { Events, type SessionHostStatusReport } from "@vcpdeck/shared";
import type { Socket } from "socket.io-client";
import type { SessionHostClient } from "./client.js";

/** 桥只依赖状态查询能力，结构上就拿不到「关闭实例」这类指令执行权。 */
export interface SessionHostBridgeDeps {
	clientHost: Pick<SessionHostClient, "status">;
}

export interface SessionHostBridge {
	/** 主动上报一次宿主状态（注册确认时与 Server 要求时调用）。 */
	report(): Promise<void>;
	dispose(): void;
}

const UNAVAILABLE_REPORT: SessionHostStatusReport = { available: false, hostId: null, instances: [] };

/**
 * 绑定会话宿主对账桥。
 *
 * 与旧 Terminal 对账完全并存且互不影响：
 * - 只发 `SESSION_HOST_STATE`，绝不触碰任何 `terminal:*` 事件；
 * - 宿主不可达时上报 `available: false`，不把「查不到」当成「实例都已退出」，
 *   也不会因此产生任何关闭指令；
 * - 不重试、不代 Server 判断实例生死。
 */
export function attachSessionHostBridge(socket: Socket, deps: SessionHostBridgeDeps): SessionHostBridge {
	async function report(): Promise<void> {
		if (!socket.connected) return;
		let value: SessionHostStatusReport;
		try {
			value = await deps.clientHost.status();
		} catch {
			value = UNAVAILABLE_REPORT;
		}
		if (!socket.connected) return;
		socket.emit(Events.SESSION_HOST_STATE, value);
	}

	function onAck(data: { event?: string } | undefined): void {
		if (data?.event !== Events.REGISTER) return;
		void report();
	}

	socket.on("ack", onAck);

	return {
		report,
		dispose() {
			socket.off("ack", onAck);
		},
	};
}
