import { randomUUID } from "node:crypto";
import type { PiClientEvent, PiEvent, PiRequest, PiResponse, PiStateAck, PiStateReport } from "@vcpdeck/shared";
import type { PiWorkerOutboundMessage, PiWorkerRequestMessage } from "./worker-protocol.js";
/** Worker 进程句柄（测试注入） */
export interface PiWorkerHandle {
    send(msg: PiWorkerRequestMessage): void;
    onMessage(listener: (msg: PiWorkerOutboundMessage) => void): () => void;
    onExit(listener: (code: number) => void): () => void;
    kill(): void;
}
export interface PiSupervisor {
    request(request: PiRequest, timeoutMs?: number): Promise<PiResponse>;
    getStateReport(): PiStateReport;
    applyStateAck(ack: PiStateAck): Promise<{
        allClosed: boolean;
    }>;
    onEvent(listener: (event: PiEvent) => void): () => void;
    shutdown(): Promise<void>;
}
export declare function createPiSupervisor(options: {
    clientId: string;
    forkWorker: (cwd: string) => PiWorkerHandle;
    /** 允许的根列表提供者（默认 discoverRoots；测试注入） */
    rootsProvider?: () => Promise<string[]>;
}): PiSupervisor;
/** 组装 PiEvent 包装（供 bridge 转发） */
export declare function wrapPiEvent(clientId: string, sessionId: string, jobId: string, runId: string, event: PiClientEvent): PiEvent;
export { randomUUID as piRequestId };
