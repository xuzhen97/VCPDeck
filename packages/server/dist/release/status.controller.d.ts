import { ReleaseService } from "./release.service.js";
export declare class StatusController {
    private readonly releases;
    constructor(releases: ReleaseService);
    /** launcher 健康探活使用，公开 */
    get(): Promise<{
        serverVersion: string;
        activeRelease: import("@vcpdeck/shared").ReleaseInfo | null;
    }>;
}
