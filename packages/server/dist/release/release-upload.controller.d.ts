import type { ActorContext, ReleaseInfo } from "@vcpdeck/shared";
import { ReleaseUploadService, type ReleaseUploadApiPart, type ReleaseUploadApiSession } from "./release-upload.service.js";
/** Release 外部 Provider 直传控制面 API；不接收构件正文。 */
export declare class ReleaseUploadController {
    private readonly uploads;
    constructor(uploads: ReleaseUploadService);
    create(raw: unknown, actor?: ActorContext): Promise<ReleaseUploadApiSession>;
    refreshParts(sessionId: string, raw: unknown): Promise<{
        parts: ReleaseUploadApiPart[];
    }>;
    complete(sessionId: string, raw: unknown): Promise<{
        release: ReleaseInfo;
    }>;
    private parse;
    private toHttp;
}
