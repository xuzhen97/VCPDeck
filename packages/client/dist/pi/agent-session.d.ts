import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type PiAction, type PiAgentState, type PiClientEvent } from "@vcpdeck/shared";
export interface PiAgentSessionOptions {
    cwd: string;
    sessionFile?: string;
    initialModel?: {
        provider: string;
        modelId: string;
    };
    thinkingLevel?: ThinkingLevel;
    /** 项目信任决策（默认：ProjectTrustStore + Owner confirm） */
    trustResolver?: (cwd: string, ask: (message: string) => Promise<boolean>) => Promise<boolean>;
}
export interface PiAgentSessionWrapper {
    readonly sessionId: string;
    isAlive(): boolean;
    isRunning(): boolean;
    onEvent(listener: (event: PiClientEvent) => void): () => void;
    send(action: PiAction, payload?: Record<string, unknown>): Promise<unknown>;
    getState(): PiAgentState;
    ensureProjectTrust(): Promise<boolean>;
    shutdown(): Promise<void>;
    destroy(): void;
}
export declare function startPiAgentSession(options: PiAgentSessionOptions): Promise<PiAgentSessionWrapper>;
/** confirm 询问通过 Extension UI 事件流交给 Owner */
export declare class PiAgentSessionWrapperImpl implements PiAgentSessionWrapper {
    readonly inner: AgentSession;
    private listeners;
    private pendingUi;
    private extensionUiQueue;
    private promptRunning;
    private extensionsBound;
    private extensionBindingPromise;
    private unsubscribe;
    private idleTimer;
    private onDestroyCallback;
    private shutdownPromise;
    private projectTrustResolver;
    private projectTrustPromise;
    private _alive;
    constructor(inner: AgentSession);
    get sessionId(): string;
    isAlive(): boolean;
    isRunning(): boolean;
    start(): void;
    onEvent(listener: (event: PiClientEvent) => void): () => void;
    private emit;
    private resetIdleTimer;
    private beginExtensionBinding;
    private ensureExtensionsBound;
    send(action: PiAction, payload?: Record<string, unknown>): Promise<unknown>;
    private listModels;
    private getCommands;
    getState(): PiAgentState;
    private fork;
    private clone;
    private createExtensionUiContext;
    private emitUi;
    private requestExtensionUi;
    private activateNextExtensionUi;
    private finishExtensionUi;
    private resolveExtensionUiResponse;
    setProjectTrustResolver(resolver: (ask: (message: string) => Promise<boolean>) => Promise<boolean>): void;
    ensureProjectTrust(): Promise<boolean>;
    /** Project Trust confirm：通过 Extension UI 事件流交给 Owner */
    askConfirm(message: string): Promise<boolean>;
    private waitForStopped;
    shutdown(): Promise<void>;
    destroy(): void;
    onDestroy(cb: () => void): void;
}
