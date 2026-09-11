export { releasesDir, releaseZipPath } from "./release-paths.js";
import type { IncomingMessage } from "node:http";
import type { Response } from "express";
import { ReleaseService } from "./release.service.js";
import { ReleaseOrchestrator } from "./release.orchestrator.js";
import { StorageService } from "../storage/storage.service.js";
import type { ActorContext } from "@vcpdeck/shared";
export declare class ReleaseController {
    private readonly service;
    private readonly orchestrator;
    private readonly storage;
    /** 外部存储直链短时缓存（ADR-0019：用的时候现取，短 TTL 不暴露给目标机） */
    private readonly directUrls;
    constructor(service: ReleaseService, orchestrator: ReleaseOrchestrator, storage: StorageService);
    list(page?: string, pageSize?: string): Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").ReleaseInfo>>;
    /** 更新包下载：客户端 launcher 使用，公开（完整性由 sha256 校验兑底）；按平台选包 */
    download(version: string, res: Response, platform?: string): Promise<void>;
    /**
     * 上传更新包：POST /api/releases/upload?version=x.y.z&platform=win-x64|linux-x64&sha256=<64hex>
     * body 为 zip 原始字节（content-type: application/zip）。两个平台各上传一次；
     * 两个平台构件齐备后才自动触发更新。操作者由 AuthGuard 注入，审计用。
     */
    upload(req: IncomingMessage, version?: string, platform?: string, sha256?: string, actor?: ActorContext): Promise<{
        release: import("@vcpdeck/shared").ReleaseInfo;
    }>;
    /**
     * 换取直链下载 URL（ADR-0019）：短时缓存，过期/失败时重新换取；
     * 不支持的 provider 或换取失败返回 null，由调用方降级。
     */
    private resolveDirectUrl;
}
