/** 内存 Prisma（client + terminalSession + terminalAuditEvent）。 */
export declare function makeMemoryPrisma(): {
    clients: Map<string, Record<string, unknown>>;
    sessions: Map<string, Record<string, unknown>>;
    audits: Record<string, unknown>[];
    prisma: never;
    audit: never;
};
/** fake Client：模拟 Client 桥（shells/create/attach/input/resize/close + 输出）。 */
export declare function makeFakeClient(): {
    broker: {
        emitter: ((socketId: string, request: unknown) => void) | null;
        pending: Map<string, {
            socketId: string;
            resolve: (r: unknown) => void;
            timer: ReturnType<typeof setTimeout>;
        }>;
        bindEmitter(fn: (socketId: string, request: unknown) => void): void;
        request(lease: {
            clientId: string;
            socketId: string;
        }, request: {
            requestId: string;
        }): Promise<unknown>;
        resolve(socketId: string, response: {
            requestId: string;
        }): void;
    };
    ptys: Map<string, {
        seq: number;
        cols: number;
        rows: number;
    }>;
    receivedInput: {
        sessionId: string;
        data: string;
    }[];
    bindClientSocket: (socketId: string) => void;
    setOnOutput: (fn: (sessionId: string, data: string) => void) => void;
    setOnClientResponse: (fn: (socketId: string, response: unknown) => void) => void;
};
