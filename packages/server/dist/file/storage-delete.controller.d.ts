import { FileService } from "./file.service.js";
import { StorageService } from "../storage/storage.service.js";
/** 受控 Storage 删除入口：已登记 File 必须经过 FileService 保留锁。 */
export declare class StorageDeleteController {
    private readonly files;
    private readonly storage;
    constructor(files: FileService, storage: StorageService);
    delete(key: string): Promise<{
        ok: boolean;
    }>;
}
