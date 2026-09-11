import { type ActorContext, type PiPromptAccepted, type PiSessionCreated, type PiSessionJobSnapshot, type PiSessionOpenResult } from "@vcpdeck/shared";
import { ClientService } from "../client/client.service.js";
import { PiEventBroker } from "./pi-event-broker.js";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";
import { PiAttachmentService } from "./pi-attachment.service.js";
/** 机器命名空间的远程 Pi REST/SSE 接口 */
export declare class PiController {
    private readonly requests;
    private readonly events;
    private readonly runs;
    private readonly clients;
    private readonly attachments;
    constructor(requests: PiRequestBroker, events: PiEventBroker, runs: PiRunService, clients: ClientService, attachments: PiAttachmentService);
    private requirePiClient;
    /** 在单一 ready generation 内执行 REST 编排，并稳定映射 broker/generation 错误。 */
    private withReconciledClient;
    /** 使用已有 generation lease 解析不透明 projectKey（不持久化）。 */
    private resolveProjectKey;
    private requestOnce;
    private requestForClient;
    private assertSessionOwner;
    private assertActiveOwner;
    private assertIdle;
    capability(clientId: string): Promise<{
        available: true;
        sdkVersion: string;
        nodeVersion: string;
        shellKind: "configured" | "git-bash" | "path" | "system";
        sessionJobProtocolVersion?: number;
    } | {
        available: false;
        code: "PI_CLIENT_UNSUPPORTED" | "PI_NODE_UNSUPPORTED" | "PI_BASH_NOT_FOUND" | "PI_RUNTIME_UNAVAILABLE" | "PI_AUTH_UNAVAILABLE";
        message: string;
        nodeVersion?: string;
    } | {
        available: boolean;
        code: string;
        message: string;
    }>;
    models(clientId: string, rootDir: string, relativePath: string): Promise<unknown[]>;
    sessions(clientId: string, rootDir: string, relativePath: string): Promise<unknown[]>;
    sessionDetail(clientId: string, sessionId: string, rootDir: string, relativePath: string): Promise<unknown>;
    sessionContext(clientId: string, sessionId: string, rootDir: string, relativePath: string, leafId?: string, cursor?: string): Promise<unknown>;
    entryContent(clientId: string, sessionId: string, entryId: string, rootDir: string, relativePath: string, blockIndex?: string): Promise<unknown>;
    renameSession(clientId: string, sessionId: string, body: {
        rootDir?: string;
        relativePath?: string;
        name?: string;
    }, actor: ActorContext): Promise<{
        ok: boolean;
    }>;
    deleteSession(clientId: string, sessionId: string, body: {
        rootDir?: string;
        relativePath?: string;
    }, actor: ActorContext): Promise<{
        ok: boolean;
    }>;
    forkSession(clientId: string, sessionId: string, body: {
        rootDir?: string;
        relativePath?: string;
        messageId?: string;
    }, actor: ActorContext): Promise<PiSessionCreated>;
    cloneSession(clientId: string, sessionId: string, body: {
        rootDir?: string;
        relativePath?: string;
    }, actor: ActorContext): Promise<PiSessionCreated>;
    navigateSession(clientId: string, sessionId: string, body: {
        rootDir?: string;
        relativePath?: string;
        targetId?: string;
    }, actor: ActorContext): Promise<unknown>;
    private ensureCreatedSession;
    newSession(clientId: string, body: unknown, actor: ActorContext): Promise<PiSessionCreated>;
    openSession(clientId: string, sessionId: string, body: unknown, actor: ActorContext): Promise<PiSessionOpenResult>;
    completeSession(clientId: string, sessionId: string, body: unknown, actor: ActorContext): Promise<PiSessionJobSnapshot>;
    agentState(clientId: string, sessionId: string, rootDir: string, relativePath: string): Promise<unknown>;
    prompt(clientId: string, sessionId: string, body: {
        rootDir?: string;
        relativePath?: string;
        type?: string;
        submissionId?: string;
        prompt?: string;
        images?: unknown[];
    }, actor: ActorContext): Promise<PiPromptAccepted>;
    stream(clientId: string, sessionId: string): import("rxjs").Observable<import("@nestjs/common").MessageEvent>;
    running(clientId: string): Promise<{
        jobId: string;
        runId: string;
        sessionId: string;
        status: string;
    }[]>;
    createAttachments(clientId: string, body: {
        images?: Array<{
            filename?: string;
            size?: number;
            mimeType?: string;
        }>;
    }): Promise<{
        fileId: string;
        uploadUrl: string;
        expiresAt: number;
    }[]>;
    completeAttachment(clientId: string, attachmentId: string): Promise<import("@vcpdeck/shared").PiAttachmentRef>;
    deleteAttachment(clientId: string, attachmentId: string): Promise<{
        ok: boolean;
    }>;
    private controlAction;
    steer(clientId: string, sessionId: string, body: {
        runId?: string;
        message?: string;
    }, actor: ActorContext): Promise<unknown>;
    followUp(clientId: string, sessionId: string, body: {
        runId?: string;
        message?: string;
    }, actor: ActorContext): Promise<unknown>;
    abort(clientId: string, sessionId: string, body: {
        runId?: string;
    }, actor: ActorContext): Promise<{
        ok: boolean;
    }>;
    compact(clientId: string, sessionId: string, body: {
        runId?: string;
        customInstructions?: string;
    }, actor: ActorContext): Promise<unknown>;
    abortCompact(clientId: string, sessionId: string, body: {
        runId?: string;
    }, actor: ActorContext): Promise<unknown>;
    extensionResponse(clientId: string, sessionId: string, body: {
        runId?: string;
        requestId?: string;
        value?: string;
        confirmed?: boolean;
        cancelled?: boolean;
    }, actor: ActorContext): Promise<{
        ok: boolean;
    }>;
    private idleAction;
    setModel(clientId: string, sessionId: string, body: {
        rootDir?: string;
        relativePath?: string;
        provider?: string;
        modelId?: string;
    }, actor: ActorContext): Promise<unknown>;
    setThinking(clientId: string, sessionId: string, body: {
        rootDir?: string;
        relativePath?: string;
        level?: string;
    }, actor: ActorContext): Promise<unknown>;
}
