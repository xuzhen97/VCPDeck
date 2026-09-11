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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReleaseController = exports.releaseZipPath = exports.releasesDir = void 0;
/**
 * Release REST API：更新包上传、列表、下载。
 * 上传采用 raw stream（POST body 为 zip 字节，version/sha256 走 query），
 * 避免引入 multipart/multer 依赖。详见 docs/design/release-and-update.md。
 */
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const release_paths_js_1 = require("./release-paths.js");
var release_paths_js_2 = require("./release-paths.js");
Object.defineProperty(exports, "releasesDir", { enumerable: true, get: function () { return release_paths_js_2.releasesDir; } });
Object.defineProperty(exports, "releaseZipPath", { enumerable: true, get: function () { return release_paths_js_2.releaseZipPath; } });
const promises_2 = require("node:stream/promises");
const release_service_js_1 = require("./release.service.js");
const release_orchestrator_js_1 = require("./release.orchestrator.js");
const direct_url_cache_js_1 = require("./direct-url-cache.js");
const storage_service_js_1 = require("../storage/storage.service.js");
const public_decorator_js_1 = require("../auth/public.decorator.js");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DIRECT_URL_ATTEMPTS = 3;
const DIRECT_URL_RETRY_DELAYS_MS = [100, 250];
function isTransientProviderError(error) {
    return (error instanceof TypeError ||
        (error instanceof Error && /HTTP (500|502|503|504)\b/.test(error.message)));
}
function providerErrorStatus(error) {
    if (!(error instanceof Error))
        return "unknown";
    return /HTTP (\d{3})\b/.exec(error.message)?.[1] ?? "network";
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isPlatform(v) {
    return v === "win-x64" || v === "linux-x64";
}
/** Provider 返回的直链只允许带主机名的 HTTP(S) URL。 */
function safeDirectUrl(value) {
    try {
        const parsed = new URL(value);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
            !parsed.hostname ||
            parsed.username ||
            parsed.password) {
            return null;
        }
        return parsed.toString();
    }
    catch {
        return null;
    }
}
/** 上传临时目录（校验通过后移动到最终路径） */
const UPLOAD_TMP_DIR = (0, node_path_1.join)((0, node_os_1.tmpdir)(), "vcpdeck-release-upload");
/** ReleaseError code → HTTP 状态 */
const RELEASE_ERROR_STATUS = {
    RELEASE_DUPLICATE_VERSION: 409,
    RELEASE_NOT_FOUND: 404,
    RELEASE_INVALID_TRANSITION: 409,
    RELEASE_SHA256_MISMATCH: 400,
    RELEASE_DIRECT_UPLOAD_REQUIRED: 409,
};
function toHttp(e) {
    return new common_1.HttpException({ code: e.code, message: e.message }, RELEASE_ERROR_STATUS[e.code] ?? 500);
}
/** 移动到最终路径且不覆盖既有 archive；跨盘/不支持硬链接时独占复制。 */
async function moveFileExclusive(src, dest) {
    try {
        await (0, promises_1.link)(src, dest);
        await (0, promises_1.rm)(src, { force: true });
        return;
    }
    catch (error) {
        const code = error.code;
        if (code === "EEXIST")
            throw error;
        if (code !== "EXDEV" && code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "ENOSYS") {
            throw error;
        }
    }
    await (0, promises_1.copyFile)(src, dest, node_fs_1.constants.COPYFILE_EXCL);
    await (0, promises_1.rm)(src, { force: true });
}
let ReleaseController = class ReleaseController {
    service;
    orchestrator;
    storage;
    /** 外部存储直链短时缓存（ADR-0019：用的时候现取，短 TTL 不暴露给目标机） */
    directUrls = new direct_url_cache_js_1.DirectUrlCache();
    constructor(service, orchestrator, storage) {
        this.service = service;
        this.orchestrator = orchestrator;
        this.storage = storage;
    }
    async list(page, pageSize) {
        return this.service.list(page ? Math.max(1, parseInt(page, 10)) : undefined, pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10))) : undefined);
    }
    /** 更新包下载：客户端 launcher 使用，公开（完整性由 sha256 校验兑底）；按平台选包 */
    async download(version, res, platform) {
        if (!isPlatform(platform)) {
            throw new common_1.BadRequestException("platform 应为 win-x64 或 linux-x64");
        }
        const info = await this.service.findByVersionWithStorage(version);
        if (!info) {
            throw new common_1.NotFoundException({
                code: "RELEASE_NOT_FOUND",
                message: `release ${version} 不存在`,
            });
        }
        const archive = info.archives[platform];
        if (!archive) {
            throw new common_1.NotFoundException({
                code: "RELEASE_ARCHIVE_MISSING",
                message: `release ${version} 缺少 ${platform} 构件`,
            });
        }
        if (archive.availability === "deleting") {
            throw new common_1.ConflictException({
                code: "RELEASE_ARCHIVE_CLEANING",
                message: "更新包正在清理，请稍后重试",
            });
        }
        if (archive.availability === "cleaned") {
            throw new common_1.HttpException({
                code: "RELEASE_ARCHIVE_CLEANED",
                message: "更新包归档已清理",
            }, 410);
        }
        // 上面已排除缺失、deleting 和 cleaned，剩余状态均为可用 archive。
        // ADR-0019：外部存储后端 302 到临时直链，目标机直连下载不占 Server 带宽
        if (archive?.storage?.mode === "direct" && archive.storage.key) {
            const directUrl = await this.resolveDirectUrl(version, platform, archive.storage.key);
            if (directUrl) {
                res.redirect(302, directUrl);
                return;
            }
            // 降级：本地有构件时回到中转；否则明确失败
            if (!(0, node_fs_1.existsSync)((0, release_paths_js_1.releaseZipPath)(version, platform))) {
                res.status(502).json({
                    code: "RELEASE_DIRECT_URL_UNAVAILABLE",
                    message: "直链换取失败且无本地构件可用",
                });
                return;
            }
        }
        res.sendFile((0, release_paths_js_1.releaseZipPath)(version, platform), { headers: { "content-type": "application/zip" } }, (err) => {
            if (err && !res.headersSent) {
                res.status(404).json({
                    code: "RELEASE_FILE_MISSING",
                    message: "更新包文件不存在",
                });
            }
        });
    }
    /**
     * 上传更新包：POST /api/releases/upload?version=x.y.z&platform=win-x64|linux-x64&sha256=<64hex>
     * body 为 zip 原始字节（content-type: application/zip）。两个平台各上传一次；
     * 两个平台构件齐备后才自动触发更新。操作者由 AuthGuard 注入，审计用。
     */
    async upload(req, version, platform, sha256, actor) {
        if (!version || !VERSION_RE.test(version)) {
            throw new common_1.BadRequestException("版本号格式应为 x.y.z");
        }
        if (!isPlatform(platform)) {
            throw new common_1.BadRequestException("platform 应为 win-x64 或 linux-x64");
        }
        if (!sha256 || !SHA256_RE.test(sha256)) {
            throw new common_1.BadRequestException("sha256 应为 64 位十六进制");
        }
        const backend = await this.storage.getBackendConfig();
        if (backend.kind === "alibaba") {
            throw toHttp(new release_service_js_1.ReleaseError("RELEASE_DIRECT_UPLOAD_REQUIRED", "Alibaba 存储必须使用 Release 直传会话"));
        }
        await (0, promises_1.mkdir)(UPLOAD_TMP_DIR, { recursive: true });
        const tempPath = (0, node_path_1.join)(UPLOAD_TMP_DIR, (0, node_crypto_1.randomUUID)());
        let moved = false;
        try {
            await (0, promises_2.pipeline)(req, (0, node_fs_1.createWriteStream)(tempPath));
            const ok = await this.service.verifyZipSha256(tempPath, sha256);
            if (!ok) {
                throw new release_service_js_1.ReleaseError("RELEASE_SHA256_MISMATCH", "文件 sha256 与声明不符");
            }
            const fileName = `vcpdeck-${version}-${platform}.zip`;
            const size = (await (0, promises_1.stat)(tempPath)).size;
            const existing = await this.service.findByVersionWithStorage(version);
            if (existing?.archives[platform]) {
                throw new release_service_js_1.ReleaseError("RELEASE_ARCHIVE_EXISTS", `release ${version} 已存在 ${platform} 构件`);
            }
            const finalPath = (0, release_paths_js_1.releaseZipPath)(version, platform);
            await (0, promises_1.mkdir)((0, release_paths_js_1.releasesDir)(), { recursive: true });
            try {
                await moveFileExclusive(tempPath, finalPath);
            }
            catch (error) {
                if (error.code === "EEXIST") {
                    throw new release_service_js_1.ReleaseError("RELEASE_ARCHIVE_EXISTS", `release ${version} 已存在 ${platform} 构件`);
                }
                throw error;
            }
            moved = true;
            const archive = { sha256, fileName, size };
            const release = existing
                ? await this.service.addArchive(version, platform, archive)
                : await this.service.create({
                    version,
                    archives: { [platform]: archive },
                    createdByName: actor?.displayName,
                    createdVia: actor?.source,
                });
            // 两个平台构件齐备才触发自更新（不阻塞上传响应；失败由编排器落库标记）
            if (this.service.hasAllArchives(release)) {
                void this.orchestrator
                    .startRelease(version)
                    .catch((e) => {
                    console.error(`[release] 触发更新失败: ${version}`, e);
                });
            }
            return { release };
        }
        catch (e) {
            if (e instanceof release_service_js_1.ReleaseError)
                throw toHttp(e);
            throw e;
        }
        finally {
            if (!moved) {
                await (0, promises_1.rm)(tempPath, { force: true }).catch(() => undefined);
            }
        }
    }
    /**
     * 换取直链下载 URL（ADR-0019）：短时缓存，过期/失败时重新换取；
     * 不支持的 provider 或换取失败返回 null，由调用方降级。
     */
    async resolveDirectUrl(version, platform, key) {
        const cacheKey = `${version}:${platform}:${key}`;
        const cached = this.directUrls.get(cacheKey);
        if (cached)
            return cached;
        for (let attempt = 0; attempt < DIRECT_URL_ATTEMPTS; attempt++) {
            try {
                const direct = await this.storage.getDirectDownloadUrl(key);
                const directUrl = direct?.url ? safeDirectUrl(direct.url) : null;
                const expiresAt = direct?.expiresAt;
                if (directUrl) {
                    // 过期时间未知/非法时不缓存，避免短 TTL 直链被长期复用
                    if (typeof expiresAt === "number" &&
                        Number.isFinite(expiresAt) &&
                        expiresAt > 0) {
                        this.directUrls.set(cacheKey, directUrl, expiresAt);
                    }
                    return directUrl;
                }
                return null;
            }
            catch (e) {
                const retryable = isTransientProviderError(e);
                const status = providerErrorStatus(e);
                if (!retryable || attempt >= DIRECT_URL_ATTEMPTS - 1) {
                    console.warn(`[release] 直链换取失败: attempt=${attempt + 1}/${DIRECT_URL_ATTEMPTS}, status=${status}`);
                    return null;
                }
                console.warn(`[release] 直链换取重试: attempt=${attempt + 1}/${DIRECT_URL_ATTEMPTS}, status=${status}`);
                await sleep(DIRECT_URL_RETRY_DELAYS_MS[attempt] ?? 250);
            }
        }
        return null;
    }
};
exports.ReleaseController = ReleaseController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)("page")),
    __param(1, (0, common_1.Query)("pageSize")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "list", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)(":version/file"),
    __param(0, (0, common_1.Param)("version")),
    __param(1, (0, common_1.Res)()),
    __param(2, (0, common_1.Query)("platform")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, String]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "download", null);
__decorate([
    (0, common_1.Post)("upload"),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)("version")),
    __param(2, (0, common_1.Query)("platform")),
    __param(3, (0, common_1.Query)("sha256")),
    __param(4, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, String, String, String, Object]),
    __metadata("design:returntype", Promise)
], ReleaseController.prototype, "upload", null);
exports.ReleaseController = ReleaseController = __decorate([
    (0, common_1.Controller)("api/releases"),
    __param(0, (0, common_1.Inject)(release_service_js_1.ReleaseService)),
    __param(1, (0, common_1.Inject)(release_orchestrator_js_1.ReleaseOrchestrator)),
    __param(2, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __metadata("design:paramtypes", [release_service_js_1.ReleaseService, release_orchestrator_js_1.ReleaseOrchestrator, storage_service_js_1.StorageService])
], ReleaseController);
