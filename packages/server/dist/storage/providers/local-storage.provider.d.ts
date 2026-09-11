import type { Readable } from "node:stream";
import { type StorageProvider, type FileMeta, type FileEntry } from "./storage-provider.interface.js";
/**
 * 解析 local 存储根目录：绝对 baseDir 原样返回；相对 baseDir 锚定到
 * VCPDECK_APP_DIR（版本目录外，Launcher 场景下自更新切换版本不漂移）
 * 或 cwd（无 app-dir 的裸 node 快速验证，维持原行为）。
 */
export declare function resolveStorageBaseDir(raw: string | undefined, appDir?: string | undefined): string;
export declare class LocalStorageProvider implements StorageProvider {
    private readonly baseDir;
    private readonly signSecret;
    constructor(config?: Record<string, unknown>);
    upload(stream: Readable, meta: FileMeta): Promise<FileEntry>;
    uploadToKey(stream: Readable, meta: FileMeta, key: string): Promise<FileEntry>;
    download(key: string): Promise<{
        stream: Readable;
        meta: FileEntry;
    }>;
    delete(key: string): Promise<void>;
    signDownloadUrl(key: string, expiresInSeconds: number): string;
    signUploadUrl(key: string, expiresInSeconds: number): string;
    verifyDownloadSignature(key: string, expiresAt: number, sig: string): boolean;
    verifyUploadSignature(key: string, expiresAt: number, sig: string): boolean;
    private makeKey;
    private sign;
}
