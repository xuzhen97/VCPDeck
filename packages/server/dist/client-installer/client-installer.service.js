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
exports.ClientInstallerService = exports.ClientInstallerError = void 0;
exports.installerAssetsDir = installerAssetsDir;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const common_1 = require("@nestjs/common");
const shared_1 = require("@vcpdeck/shared");
const client_service_js_1 = require("../client/client.service.js");
const client_psk_js_1 = require("../client/client-psk.js");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const release_service_js_1 = require("../release/release.service.js");
const CONFIG_ID = "default";
const ClientInstallerErrorCode = {
    DISABLED: "CLIENT_INSTALLER_DISABLED",
    RELEASE_NOT_READY: "CLIENT_INSTALLER_RELEASE_NOT_READY",
    ARCHIVE_MISSING: "CLIENT_INSTALLER_ARCHIVE_MISSING",
    ASSET_MISSING: "CLIENT_INSTALLER_ASSET_MISSING",
    PSK_INVALID: "CLIENT_INSTALLER_PSK_INVALID",
};
const INSTALLER_ASSETS = [
    "install-client-bootstrap.sh",
    "install-client-bootstrap.ps1",
    "install-client.cjs",
    "install-client-linux.cjs",
    "install.cjs",
    "uninstall-client-bootstrap.sh",
    "uninstall-client-bootstrap.ps1",
    "uninstall-client.cjs",
    "uninstall-client-linux.cjs",
];
/** 按平台选择安装器资产：linux-x64 走 A2 系统安装器，win-x64 保持 PM2 安装器。 */
function installerAssetName(platform) {
    return platform === "linux-x64" ? "install-client-linux.cjs" : "install-client.cjs";
}
/** Client 安装领域错误。 */
class ClientInstallerError extends Error {
    code;
    statusCode;
    constructor(code, message, statusCode) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.ClientInstallerError = ClientInstallerError;
/** 管理一键安装开关、目标 Release、安装资产与 Client 验收。 */
let ClientInstallerService = class ClientInstallerService {
    prisma;
    releases;
    clients;
    constructor(prisma, releases, clients) {
        this.prisma = prisma;
        this.releases = releases;
        this.clients = clients;
    }
    async getConfig() {
        const [config, release] = await Promise.all([
            this.ensureConfig(),
            this.releases.findByVersion(shared_1.VERSION),
        ]);
        const releaseReady = release?.status === shared_1.ReleaseStatus.DONE;
        return {
            enabled: config.enabled,
            updatedAt: config.updatedAt?.toISOString() ?? null,
            updatedByName: config.updatedByName,
            updatedVia: config.updatedVia,
            serverVersion: shared_1.VERSION,
            releaseReady,
            platforms: {
                "win-x64": this.platformStatus(releaseReady, (0, shared_1.isReleaseArchiveAvailable)(release?.archives["win-x64"])),
                "linux-x64": this.platformStatus(releaseReady, (0, shared_1.isReleaseArchiveAvailable)(release?.archives["linux-x64"])),
            },
        };
    }
    async updateConfig(enabled, actor) {
        await this.ensureConfig();
        await this.prisma.$executeRawUnsafe(`UPDATE ClientInstallerConfig
			 SET enabled = ?, updatedByIdentityId = ?, updatedByName = ?, updatedVia = ?, updatedAt = CURRENT_TIMESTAMP
			 WHERE id = ?`, enabled ? 1 : 0, actor.identityId, actor.displayName, actor.source, CONFIG_ID);
        return this.getConfig();
    }
    async preflight(platform) {
        const releasePlatform = platform;
        const release = await this.requireReadyRelease(releasePlatform);
        const archive = release.archives[releasePlatform];
        if (!archive || !(0, shared_1.isReleaseArchiveAvailable)(archive)) {
            throw new ClientInstallerError(ClientInstallerErrorCode.ARCHIVE_MISSING, `当前 Release 缺少可用的 ${releasePlatform} 构件`, 409);
        }
        const installerName = installerAssetName(platform);
        const installer = this.readAsset(installerName);
        const lowLevelInstaller = this.readAsset("install.cjs");
        return {
            serverVersion: shared_1.VERSION,
            releaseVersion: release.version,
            platform,
            archiveSize: archive.size,
            installerUrl: `/api/client-installer/assets/${installerName}`,
            installerSha256: sha256(installer),
            lowLevelInstallerUrl: "/api/client-installer/assets/install.cjs",
            lowLevelInstallerSha256: sha256(lowLevelInstaller),
            nodeConstraint: ">=24",
            nodeMirrors: ["https://npmmirror.com/mirrors/node", "https://nodejs.org/dist"],
            npmRegistries: ["https://registry.npmmirror.com", "https://registry.npmjs.org"],
        };
    }
    async bootstrap(platform) {
        const releasePlatform = platform;
        const release = await this.requireReadyRelease(releasePlatform);
        const archive = release.archives[releasePlatform];
        if (!archive || !(0, shared_1.isReleaseArchiveAvailable)(archive)) {
            throw new ClientInstallerError(ClientInstallerErrorCode.ARCHIVE_MISSING, `当前 Release 缺少可用的 ${releasePlatform} 构件`, 409);
        }
        return {
            serverVersion: shared_1.VERSION,
            releaseVersion: release.version,
            platform,
            archiveUrl: `/api/releases/${encodeURIComponent(release.version)}/file?platform=${platform}`,
            archiveSha256: archive.sha256,
            archiveSize: archive.size,
            psk: (0, client_psk_js_1.clientPsk)(),
            verificationTimeoutMs: 120_000,
        };
    }
    readAsset(name) {
        const root = installerAssetsDir();
        const path = (0, node_path_1.resolve)(root, name);
        if (!path.startsWith(`${(0, node_path_1.resolve)(root)}${process.platform === "win32" ? "\\" : "/"}`) || !(0, node_fs_1.existsSync)(path)) {
            throw new ClientInstallerError(ClientInstallerErrorCode.ASSET_MISSING, `安装资产 ${name} 不存在`, 503);
        }
        return (0, node_fs_1.readFileSync)(path);
    }
    async getClientStatus(clientId) {
        await this.requireEnabled();
        return this.clients.getInstallerStatus(clientId);
    }
    async renameClient(clientId, name) {
        await this.requireEnabled();
        return this.clients.rename(clientId, name);
    }
    assertPsk(value) {
        if (!value || value !== (0, client_psk_js_1.clientPsk)()) {
            throw new ClientInstallerError(ClientInstallerErrorCode.PSK_INVALID, "Client 安装凭据无效", 401);
        }
    }
    async requireReadyRelease(platform) {
        await this.requireEnabled();
        const release = await this.releases.findByVersion(shared_1.VERSION);
        if (!release || release.status !== shared_1.ReleaseStatus.DONE) {
            throw new ClientInstallerError(ClientInstallerErrorCode.RELEASE_NOT_READY, "当前 Server 版本没有已完成的 Release", 409);
        }
        if (!(0, shared_1.isReleaseArchiveAvailable)(release.archives[platform])) {
            throw new ClientInstallerError(ClientInstallerErrorCode.ARCHIVE_MISSING, `当前 Release 缺少可用的 ${platform} 构件`, 409);
        }
        return release;
    }
    async requireEnabled() {
        const config = await this.ensureConfig();
        if (!config.enabled) {
            throw new ClientInstallerError(ClientInstallerErrorCode.DISABLED, "Server 已关闭 Client 一键安装", 403);
        }
    }
    async ensureConfig() {
        await this.prisma.$executeRawUnsafe(`INSERT OR IGNORE INTO ClientInstallerConfig (id, enabled, createdAt, updatedAt)
			 VALUES (?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, CONFIG_ID);
        const rows = await this.prisma.$queryRawUnsafe(`SELECT enabled, updatedAt, updatedByName, updatedVia
			 FROM ClientInstallerConfig WHERE id = ? LIMIT 1`, CONFIG_ID);
        const row = rows[0];
        if (!row)
            throw new Error("ClientInstallerConfig 初始化失败");
        return {
            enabled: Boolean(row.enabled),
            updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
            updatedByName: row.updatedByName,
            updatedVia: row.updatedVia,
        };
    }
    platformStatus(releaseReady, hasArchive) {
        if (!releaseReady) {
            return { available: false, reasonCode: ClientInstallerErrorCode.RELEASE_NOT_READY };
        }
        if (!hasArchive) {
            return { available: false, reasonCode: ClientInstallerErrorCode.ARCHIVE_MISSING };
        }
        return { available: true };
    }
};
exports.ClientInstallerService = ClientInstallerService;
exports.ClientInstallerService = ClientInstallerService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(release_service_js_1.ReleaseService)),
    __param(2, (0, common_1.Inject)(client_service_js_1.ClientService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, release_service_js_1.ReleaseService, client_service_js_1.ClientService])
], ClientInstallerService);
/** 定位随 Server 发布或仓库开发环境提供的安装资产目录。 */
function installerAssetsDir() {
    const candidates = [
        (0, node_path_1.join)(__dirname, "..", "installer"),
        (0, node_path_1.join)(__dirname, "..", "..", "installer"),
        (0, node_path_1.join)(__dirname, "..", "..", "..", "scripts"),
        (0, node_path_1.join)(__dirname, "..", "..", "..", "..", "scripts"),
    ];
    return candidates.find((path) => (0, node_fs_1.existsSync)((0, node_path_1.join)(path, "install-client.cjs"))) ?? candidates[0] ?? "";
}
function sha256(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
}
