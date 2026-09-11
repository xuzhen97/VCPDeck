"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalStorageProvider = void 0;
exports.resolveStorageBaseDir = resolveStorageBaseDir;
const common_1 = require("@nestjs/common");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const promises_2 = require("node:stream/promises");
const storage_provider_interface_js_1 = require("./storage-provider.interface.js");
const SIGN_UPLOAD_PREFIX = "upload";
const SIGN_DOWNLOAD_PREFIX = "download";
/**
 * 解析 local 存储根目录：绝对 baseDir 原样返回；相对 baseDir 锚定到
 * VCPDECK_APP_DIR（版本目录外，Launcher 场景下自更新切换版本不漂移）
 * 或 cwd（无 app-dir 的裸 node 快速验证，维持原行为）。
 */
function resolveStorageBaseDir(raw, appDir = process.env.VCPDECK_APP_DIR) {
    const base = raw || "./data/storage";
    return (0, node_path_1.resolve)(appDir || process.cwd(), base);
}
let LocalStorageProvider = class LocalStorageProvider {
    baseDir;
    signSecret;
    constructor(config = {}) {
        this.baseDir = resolveStorageBaseDir(config.baseDir);
        this.signSecret = config.signSecret || (0, node_crypto_1.randomUUID)();
    }
    async upload(stream, meta) {
        return this.uploadToKey(stream, meta, this.makeKey(meta));
    }
    async uploadToKey(stream, meta, key) {
        const filePath = (0, node_path_1.resolve)(this.baseDir, key);
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(filePath), { recursive: true });
        await (0, promises_2.pipeline)(stream, (0, node_fs_1.createWriteStream)(filePath));
        return {
            ...meta,
            key,
            storageKind: "local",
            createdAt: new Date(),
        };
    }
    async download(key) {
        const filePath = (0, node_path_1.resolve)(this.baseDir, key);
        let st;
        try {
            st = await (0, promises_1.stat)(filePath);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                throw new storage_provider_interface_js_1.StorageObjectNotFoundError();
            }
            throw error;
        }
        const filename = key.split("/").pop() || key;
        return {
            stream: (0, node_fs_1.createReadStream)(filePath),
            meta: {
                jobId: "",
                clientId: "",
                filename,
                size: st.size,
                key,
                storageKind: "local",
                // ponytail: birthtime 近似 createdAt，后续 File 表更准确
                createdAt: st.birthtime,
            },
        };
    }
    async delete(key) {
        try {
            await (0, promises_1.unlink)((0, node_path_1.resolve)(this.baseDir, key));
        }
        catch {
            // 文件已不存在，忽略
        }
    }
    signDownloadUrl(key, expiresInSeconds) {
        // ttlSeconds <= 0 表示永久链接（expires=0），由清理任务兜底回收
        const expiresAt = expiresInSeconds <= 0 ? 0 : Date.now() + expiresInSeconds * 1000;
        const sig = this.sign(`${SIGN_DOWNLOAD_PREFIX}:${key}:${expiresAt}`);
        return `expires=${expiresAt}&sig=${sig}`;
    }
    signUploadUrl(key, expiresInSeconds) {
        const expiresAt = Date.now() + expiresInSeconds * 1000;
        const sig = this.sign(`${SIGN_UPLOAD_PREFIX}:${key}:${expiresAt}`);
        return `expires=${expiresAt}&sig=${sig}`;
    }
    verifyDownloadSignature(key, expiresAt, sig) {
        // expires=0 为永久链接标记，不做时间校验
        if (expiresAt > 0 && Date.now() > expiresAt)
            return false;
        const expected = this.sign(`${SIGN_DOWNLOAD_PREFIX}:${key}:${expiresAt}`);
        return expected === sig;
    }
    verifyUploadSignature(key, expiresAt, sig) {
        if (Date.now() > expiresAt)
            return false;
        const expected = this.sign(`${SIGN_UPLOAD_PREFIX}:${key}:${expiresAt}`);
        return expected === sig;
    }
    // ── internal ──
    makeKey(meta) {
        const safeFilename = meta.filename.replace(/[\\/:*?"<>|]/g, "_");
        return `${(0, node_crypto_1.randomUUID)()}/${safeFilename}`;
    }
    sign(payload) {
        return (0, node_crypto_1.createHmac)("sha256", this.signSecret).update(payload).digest("hex");
    }
};
exports.LocalStorageProvider = LocalStorageProvider;
exports.LocalStorageProvider = LocalStorageProvider = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [Object])
], LocalStorageProvider);
