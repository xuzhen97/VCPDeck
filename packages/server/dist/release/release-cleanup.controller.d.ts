import { ReleaseCleanupService } from "./release-cleanup.service.js";
/** Release archive 清理控制面 API；默认受全局认证保护。 */
export declare class ReleaseCleanupController {
    private readonly cleanup;
    constructor(cleanup: ReleaseCleanupService);
    /** 预览固定清理策略下的候选正文和上传会话。 */
    preview(): Promise<import("@vcpdeck/shared").ReleaseCleanupPreview>;
    /** 立即按固定清理策略执行一次清理。 */
    run(): Promise<import("@vcpdeck/shared").ReleaseCleanupRunResult>;
}
