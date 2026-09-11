import { parseReleaseUploadComplete, parseReleaseUploadCreateInput, parseReleaseUploadPartRefresh, type ActorContext, type ReleaseInfo, type ReleaseUploadCreateInput, type ReleaseUploadPart, type ReleaseUploadSession } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import { ReleaseService } from "./release.service.js";
import { ReleaseOrchestrator } from "./release.orchestrator.js";
/** Server Controller 使用的 Shared Release 上传 parser。 */
export declare const ReleaseUploadContract: {
    parseCreate: typeof parseReleaseUploadCreateInput;
    parseRefresh: typeof parseReleaseUploadPartRefresh;
    parseComplete: typeof parseReleaseUploadComplete;
};
export type ReleaseUploadApiPart = ReleaseUploadPart;
export type ReleaseUploadApiSession = ReleaseUploadSession;
/** Release 直传会话领域错误。 */
export declare class ReleaseUploadError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Release 外部 Provider 直传会话、完成登记与编排入口。 */
export declare class ReleaseUploadService {
    private readonly prisma;
    private readonly storage;
    private readonly releases;
    private readonly orchestrator;
    constructor(prisma: PrismaService, storage: StorageService, releases: ReleaseService, orchestrator: ReleaseOrchestrator);
    private get uploadSessions();
    /** 协商上传模式；Alibaba 返回直传分片，Local 保留 Server 流式上传。 */
    createSession(input: ReleaseUploadCreateInput, actor?: ActorContext): Promise<ReleaseUploadApiSession>;
    /** 刷新指定分片 URL；URL 只返回调用方，不持久化。 */
    refreshParts(sessionId: string, partNumbers: number[]): Promise<{
        parts: ReleaseUploadPart[];
    }>;
    /** 完成 Provider 分片合并并登记 Release；重复完成幂等返回已登记 Release。 */
    completeSession(sessionId: string, uploadedBytes: number): Promise<{
        release: ReleaseInfo;
    }>;
    private resumeSession;
    private requirePendingSession;
    private markProviderCompleted;
    private markCompleted;
    private providerCall;
    private assertNotExpired;
    private assertPartNumbers;
    private fileName;
}
