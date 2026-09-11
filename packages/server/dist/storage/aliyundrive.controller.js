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
var AliyunDriveController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AliyunDriveController = void 0;
/**
 * 阿里云盘配置 & OAuth 管理端点
 *
 * 提供阿里云盘存储后端的配置、OAuth PKCE 授权流程。
 * 所有配置存储在 StorageBackendConfig 表的 config JSON 字段中。
 *
 * 流程：
 * 1. PUT /api/aliyundrive/config — 设置 clientId（可选 clientSecret）
 * 2. POST /api/aliyundrive/oauth/start — 获取授权 URL
 * 3. 用户在浏览器完成授权，拿到 code
 * 4. POST /api/aliyundrive/oauth/complete — 用 code 换取 token
 * 5. GET /api/aliyundrive/status — 检查授权状态
 * 6. 将 StorageBackendConfig.kind 改为 "alibaba" → StorageService.reload()
 */
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const alibaba_types_js_1 = require("./providers/alibaba-types.js");
const alibaba_openapi_client_js_1 = require("./providers/alibaba-openapi.client.js");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const storage_service_js_1 = require("./storage.service.js");
let AliyunDriveController = AliyunDriveController_1 = class AliyunDriveController {
    prisma;
    storage;
    logger = new common_1.Logger(AliyunDriveController_1.name);
    oauthSessions = new Map();
    constructor(prisma, storage) {
        this.prisma = prisma;
        this.storage = storage;
    }
    /** 获取当前配置和授权状态 */
    async getStatus() {
        const config = await this.getConfig();
        const now = Date.now();
        const hasAuth = Boolean(config?.accessToken);
        const isExpired = Boolean(config?.expiresAt && config.expiresAt <= now + 300_000);
        return {
            configured: Boolean(config?.clientId),
            authorized: Boolean(config?.accessToken && !isExpired),
            hasAuth,
            isExpired,
            clientId: config?.clientId,
            openapiBase: config?.openapiBase || alibaba_types_js_1.DEFAULT_OPENAPI_BASE,
            transferFolder: config?.transferFolder || alibaba_types_js_1.DEFAULT_TRANSFER_FOLDER,
            driveId: config?.driveId,
            expiresAt: config?.expiresAt,
        };
    }
    /** 通过阿里云盘 OpenAPI 验证当前授权是否仍可用。 */
    async verify() {
        const checkedAt = new Date().toISOString();
        const config = await this.getConfig();
        if (!config?.clientId) {
            return { valid: false, checkedAt, reason: "not_configured" };
        }
        let working = config;
        try {
            if (config.refreshToken &&
                (!config.accessToken ||
                    !config.expiresAt ||
                    config.expiresAt <= Date.now() + 300_000)) {
                working = {
                    ...config,
                    ...(await this.refreshAccessToken(config)),
                };
                await this.writeConfig(working);
            }
            if (!working.accessToken) {
                return { valid: false, checkedAt, reason: "not_authorized" };
            }
            if (working.expiresAt && working.expiresAt <= Date.now()) {
                return { valid: false, checkedAt, reason: "expired" };
            }
            const client = new alibaba_openapi_client_js_1.AlibabaOpenApiClient({
                openapiBase: working.openapiBase || alibaba_types_js_1.DEFAULT_OPENAPI_BASE,
                accessToken: working.accessToken,
            });
            const { driveId } = await client.getDriveInfo();
            await this.writeConfig({ ...working, driveId });
            return { valid: true, checkedAt, driveId };
        }
        catch (error) {
            const status = getHttpStatus(error);
            const reason = status === 401
                ? "revoked"
                : status === 403
                    ? "forbidden"
                    : status === 400
                        ? "revoked"
                        : "unreachable";
            return { valid: false, checkedAt, reason };
        }
    }
    /** 保存配置 */
    async saveConfig(body) {
        if (!body.clientId?.trim()) {
            throw Object.assign(new Error("clientId is required"), { statusCode: 400 });
        }
        const config = await this.getConfig();
        const updated = {
            ...config,
            clientId: body.clientId.trim(),
            clientSecret: body.clientSecret ?? config?.clientSecret,
            openapiBase: (body.openapiBase || config?.openapiBase || alibaba_types_js_1.DEFAULT_OPENAPI_BASE).replace(/\/+$/, ""),
            transferFolder: body.transferFolder || config?.transferFolder || alibaba_types_js_1.DEFAULT_TRANSFER_FOLDER,
        };
        await this.writeConfig(updated);
        // 不返回 clientSecret
        const { clientSecret, ...safe } = updated;
        return safe;
    }
    /** 启动 OAuth PKCE 授权流程 */
    async startOAuth() {
        const config = await this.getConfig();
        if (!config?.clientId) {
            throw Object.assign(new Error("请先配置 clientId: PUT /api/aliyundrive/config"), { statusCode: 400 });
        }
        const openapiBase = config.openapiBase || alibaba_types_js_1.DEFAULT_OPENAPI_BASE;
        const verifier = buildCodeVerifier();
        const state = (0, node_crypto_1.randomBytes)(16).toString("hex");
        let url;
        try {
            url = new URL(`${openapiBase}/oauth/authorize`);
        }
        catch {
            throw Object.assign(new Error(`无效的 openapiBase: ${openapiBase}`), { statusCode: 400 });
        }
        url.searchParams.set("client_id", config.clientId);
        url.searchParams.set("redirect_uri", "oob");
        url.searchParams.set("scope", "user:base,file:all:read,file:all:write");
        url.searchParams.set("response_type", "code");
        url.searchParams.set("state", state);
        url.searchParams.set("code_challenge", verifier);
        url.searchParams.set("code_challenge_method", "plain");
        this.oauthSessions.set(state, {
            state,
            verifier,
            config,
            expiresAt: Date.now() + 10 * 60 * 1000,
        });
        this.logger.log("OAuth 授权 URL 已生成");
        return {
            state,
            authorizationUrl: url.toString(),
            expiresAt: Date.now() + 10 * 60 * 1000,
        };
    }
    /** 完成 OAuth 授权（用 code 换取 token） */
    async completeOAuth(body) {
        const session = this.oauthSessions.get(body.state);
        if (!session || session.expiresAt < Date.now()) {
            throw Object.assign(new Error("OAuth 会话已过期，请重新发起授权"), { statusCode: 400 });
        }
        const openapiBase = session.config.openapiBase || alibaba_types_js_1.DEFAULT_OPENAPI_BASE;
        const payload = {
            client_id: session.config.clientId,
            grant_type: "authorization_code",
            code: body.code.trim(),
            code_verifier: session.verifier,
        };
        if (session.config.clientSecret) {
            payload.client_secret = session.config.clientSecret;
        }
        const response = await fetch(`${openapiBase}/oauth/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            throw Object.assign(new Error(`阿里云盘 token 交换失败: HTTP ${response.status}`), { statusCode: 400 });
        }
        const data = (await response.json());
        const updated = {
            ...session.config,
            accessToken: data.access_token,
            refreshToken: data.refresh_token ?? session.config.refreshToken,
            expiresAt: Date.now() + data.expires_in * 1000,
        };
        await this.writeConfig(updated);
        this.oauthSessions.delete(body.state);
        this.logger.log("阿里云盘 OAuth 授权成功");
        return { authorized: true, expiresAt: updated.expiresAt };
    }
    /** 撤销授权（清除 token） */
    async revoke() {
        const config = await this.getConfig();
        if (config) {
            const cleaned = {
                ...config,
                accessToken: undefined,
                refreshToken: undefined,
                expiresAt: undefined,
                driveId: undefined,
            };
            await this.writeConfig(cleaned);
        }
        return { revoked: true };
    }
    // ── private ──
    async getConfig() {
        const row = await this.prisma.storageBackendConfig.findFirst();
        if (!row)
            return null;
        try {
            return JSON.parse(row.config);
        }
        catch {
            return null;
        }
    }
    async refreshAccessToken(config) {
        if (!config.refreshToken)
            throw new Error("缺少 refresh_token");
        const openapiBase = config.openapiBase || alibaba_types_js_1.DEFAULT_OPENAPI_BASE;
        const payload = {
            client_id: config.clientId,
            grant_type: "refresh_token",
            refresh_token: config.refreshToken,
        };
        if (config.clientSecret)
            payload.client_secret = config.clientSecret;
        const response = await fetch(`${openapiBase}/oauth/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            throw Object.assign(new Error("阿里云盘 token 刷新失败"), {
                statusCode: response.status,
            });
        }
        const data = (await response.json());
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token ?? config.refreshToken,
            expiresAt: Date.now() + data.expires_in * 1000,
        };
    }
    async writeConfig(config) {
        const json = JSON.stringify(config);
        await this.prisma.storageBackendConfig.upsert({
            where: { id: 1 },
            create: { id: 1, kind: "alibaba", config: json },
            update: { config: json },
        });
        // 配置已变更：立即热切换内存 provider，避免运行中的 provider 使用旧 token。
        await this.storage.reload();
    }
};
exports.AliyunDriveController = AliyunDriveController;
__decorate([
    (0, common_1.Get)("status"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AliyunDriveController.prototype, "getStatus", null);
__decorate([
    (0, common_1.Post)("verify"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AliyunDriveController.prototype, "verify", null);
__decorate([
    (0, common_1.Put)("config"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AliyunDriveController.prototype, "saveConfig", null);
__decorate([
    (0, common_1.Post)("oauth/start"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AliyunDriveController.prototype, "startOAuth", null);
__decorate([
    (0, common_1.Post)("oauth/complete"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AliyunDriveController.prototype, "completeOAuth", null);
__decorate([
    (0, common_1.Post)("oauth/revoke"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AliyunDriveController.prototype, "revoke", null);
exports.AliyunDriveController = AliyunDriveController = AliyunDriveController_1 = __decorate([
    (0, common_1.Controller)("api/aliyundrive"),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, storage_service_js_1.StorageService])
], AliyunDriveController);
function getHttpStatus(error) {
    if (typeof error === "object" && error !== null) {
        const statusCode = error.statusCode;
        if (typeof statusCode === "number")
            return statusCode;
    }
    if (error instanceof Error) {
        const match = error.message.match(/HTTP (\d{3})/);
        if (match)
            return Number(match[1]);
    }
    return undefined;
}
/** 生成 PKCE code_verifier */
function buildCodeVerifier() {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = (0, node_crypto_1.randomBytes)(64);
    let result = "";
    for (const byte of bytes)
        result += alphabet[byte % alphabet.length];
    return result;
}
