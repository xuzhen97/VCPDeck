import type { Socket } from "socket.io-client";
export declare function handleTransfer(job: {
    jobId: string;
    type: string;
    payload: Record<string, unknown>;
    timeout?: number;
}, socket: Socket): Promise<void>;
