import type { Response } from "express";
import { StorageShareService } from "./storage-share.service.js";
import { StorageService } from "./storage.service.js";
export declare class PublicStorageShareController {
    private readonly shares;
    private readonly storage;
    constructor(shares: StorageShareService, storage: StorageService);
    /** 无认证公开读取分享文件。 */
    download(token: string, response: Response): Promise<void>;
    private mapPublicError;
}
