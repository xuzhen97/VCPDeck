import { type PiAgentState, type PiCwdRef, type PiModelInfo, type PiPromptAccepted, type PiSessionCreated, type PiSessionJobSnapshot, type PiSessionOpenResult, type PiThinkingLevel } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
export interface PiSessionsApi {
    list(clientId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<unknown>;
    get(clientId: string, sessionId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<unknown>;
    context(clientId: string, sessionId: string, cwdRef: PiCwdRef, options?: {
        leafId?: string;
        cursor?: string;
    }, signal?: AbortSignal): Promise<unknown>;
    entryContent(clientId: string, sessionId: string, entryId: string, cwdRef: PiCwdRef, blockIndex: number, signal?: AbortSignal): Promise<unknown>;
    rename(clientId: string, sessionId: string, cwdRef: PiCwdRef, name: string): Promise<unknown>;
    delete(clientId: string, sessionId: string, cwdRef: PiCwdRef): Promise<unknown>;
    fork(clientId: string, sessionId: string, cwdRef: PiCwdRef, messageId: string): Promise<unknown>;
    clone(clientId: string, sessionId: string, cwdRef: PiCwdRef): Promise<unknown>;
    navigate(clientId: string, sessionId: string, cwdRef: PiCwdRef, targetId: string): Promise<unknown>;
}
export interface PiAgentApi {
    newSession(clientId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<PiSessionCreated>;
    open(clientId: string, sessionId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<PiSessionOpenResult>;
    complete(clientId: string, sessionId: string, runId?: string, signal?: AbortSignal): Promise<PiSessionJobSnapshot>;
    state(clientId: string, sessionId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<PiAgentState>;
    prompt(clientId: string, sessionId: string, cwdRef: PiCwdRef, input: {
        submissionId: string;
        prompt: string;
        images?: unknown[];
    }, signal?: AbortSignal): Promise<PiPromptAccepted>;
    steer(clientId: string, sessionId: string, jobId: string, message: string): Promise<unknown>;
    followUp(clientId: string, sessionId: string, jobId: string, message: string): Promise<unknown>;
    abort(clientId: string, sessionId: string, jobId: string): Promise<unknown>;
    compact(clientId: string, sessionId: string, jobId: string, customInstructions?: string): Promise<unknown>;
    abortCompact(clientId: string, sessionId: string, jobId: string): Promise<unknown>;
    setModel(clientId: string, sessionId: string, cwdRef: PiCwdRef, provider: string, modelId: string): Promise<unknown>;
    setThinking(clientId: string, sessionId: string, cwdRef: PiCwdRef, level: PiThinkingLevel): Promise<unknown>;
    extensionResponse(clientId: string, sessionId: string, jobId: string, response: {
        requestId: string;
        value?: string;
        confirmed?: boolean;
        cancelled?: boolean;
    }): Promise<unknown>;
    /** SSE path（session 级；cookie 认证浏览器用 EventSource 连接） */
    eventsPath(clientId: string, sessionId: string): string;
}
export interface PiAttachmentsApi {
    create(clientId: string, images: Array<{
        filename: string;
        size: number;
        mimeType: string;
    }>, signal?: AbortSignal): Promise<Array<{
        fileId: string;
        uploadUrl: string;
        expiresAt: number;
    }>>;
    complete(clientId: string, attachmentId: string, signal?: AbortSignal): Promise<import("@vcpdeck/shared").PiAttachmentRef>;
    delete(clientId: string, attachmentId: string): Promise<unknown>;
}
export interface PiApi {
    capability(clientId: string, signal?: AbortSignal): Promise<unknown>;
    models(clientId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<PiModelInfo[]>;
    sessions: PiSessionsApi;
    agent: PiAgentApi;
    attachments: PiAttachmentsApi;
    running(clientId: string, signal?: AbortSignal): Promise<unknown>;
}
/** 创建远程 Pi REST API（机器命名空间） */
export declare function createPiApi(client: Pick<VcpDeckClient, "request">): PiApi;
