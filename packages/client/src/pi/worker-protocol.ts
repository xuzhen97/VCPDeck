import type { PiClientEvent, PiRequest, PiStateReport } from "@vcpdeck/shared";
import type { PiRuntimeConfig } from "./runtime-spec.js";

/**
 * Parent → Worker 请求消息。
 * `runtime-init` 承载 Server 下发的运行配置与凭据 lease：
 * **只允许经 IPC 传递**，禁止写入 argv / env / 磁盘（设计 §8.1）。
 */
export type PiWorkerRequestMessage =
	| { type: "runtime-init"; config: PiRuntimeConfig | null }
	| { type: "request"; projectKey: string; request: PiRequest }
	| { type: "shutdown" }
	| { type: "ack-terminal"; runIds: string[] };

/** Worker → Parent 响应消息 */
export type PiWorkerResponseMessage =
	| { type: "response"; requestId: string; ok: true; data?: unknown }
	| {
			type: "response";
			requestId: string;
			ok: false;
			error: { code: string; message: string };
	  };

/** Worker → Parent 事件消息（含关联 ID，Parent 负责组装 PiEvent 包装） */
export interface PiWorkerEventMessage {
	type: "event";
	sessionId: string;
	jobId: string;
	runId: string;
	event: PiClientEvent;
}

/** Worker → Parent 状态消息（重连报告） */
export interface PiWorkerStateMessage {
	type: "state";
	report: PiStateReport;
}

export type PiWorkerOutboundMessage =
	| PiWorkerResponseMessage
	| PiWorkerEventMessage
	| PiWorkerStateMessage;
