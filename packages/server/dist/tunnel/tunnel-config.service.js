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
exports.TunnelConfigService = exports.TunnelConfigError = void 0;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const common_1 = require("@nestjs/common");
const shared_1 = require("@vcpdeck/shared");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const CONFIG_ID = "default";
/** coturn TURN REST 临时凭据固定有效期：24 小时（秒）。 */
const TURN_TTL_SECONDS = 24 * 60 * 60;
/** 隧道配置领域错误；code 稳定，statusCode 映射 HTTP。 */
class TunnelConfigError extends Error {
    code;
    statusCode;
    constructor(code, message, statusCode) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.TunnelConfigError = TunnelConfigError;
/** 管理 P2P 隧道 ICE/coturn 配置并签发短期 TURN 凭据（secret 不落库、不外泄）。 */
let TunnelConfigService = class TunnelConfigService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    /** 返回脱敏后的 ICE/coturn 配置摘要（不含 shared secret 内容）。 */
    async get() {
        const row = await this.ensureRow();
        return (0, shared_1.parseTunnelConfigInfo)({
            stunUrls: parseJsonArray(row.stunUrls, "stunUrls"),
            turnUrls: parseJsonArray(row.turnUrls, "turnUrls"),
            realm: row.realm ?? "",
            turnSecretConfigured: await this.secretConfigured(),
            updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
        });
    }
    /** 保存非秘密配置字段；secret 不接受 REST 写入。 */
    async update(raw) {
        const parsed = (0, shared_1.parseTunnelConfigUpdate)(raw);
        await this.ensureRow();
        await this.prisma.$executeRawUnsafe(`UPDATE TunnelConfig
			 SET stunUrls = ?, turnUrls = ?, realm = ?, updatedAt = CURRENT_TIMESTAMP
			 WHERE id = ?`, JSON.stringify(parsed.stunUrls), JSON.stringify(parsed.turnUrls), parsed.realm, CONFIG_ID);
        return this.get();
    }
    /**
     * 为本次 Session 签发短期 ICE 服务器：STUN（无凭据）+ 每个 TURN URL 一份 24h 凭据。
     * 缺少 TURN URL、realm 或 shared secret 时以 TUNNEL_TURN_NOT_CONFIGURED 失败。
     */
    async issueIceServers(sessionId, now = new Date()) {
        // 首次调用即保证默认行存在：全新部署未配置 coturn 时也能签发空 ICE 列表
        // （仅主机候选），使直连 P2P 可用；TURN 仅在显式配置后才加入。
        const row = await this.ensureRow();
        const stunUrls = parseJsonArray(row.stunUrls, "stunUrls");
        const turnUrls = parseJsonArray(row.turnUrls, "turnUrls");
        const result = [];
        if (stunUrls.length > 0)
            result.push({ urls: stunUrls });
        if (turnUrls.length === 0)
            return result;
        const secret = await this.requireSecret();
        const username = `${Math.floor(now.getTime() / 1000) + TURN_TTL_SECONDS}:${sessionId}`;
        const credential = (0, node_crypto_1.createHmac)("sha1", secret).update(username).digest("base64");
        for (const url of turnUrls) {
            result.push({ urls: [url], username, credential });
        }
        return result;
    }
    async ensureRow() {
        let row = await this.prisma.tunnelConfig.findUnique({
            where: { id: CONFIG_ID },
        });
        if (!row) {
            row = await this.prisma.tunnelConfig.create({
                data: {
                    id: CONFIG_ID,
                    stunUrls: "[]",
                    turnUrls: "[]",
                    realm: "",
                    updatedAt: new Date(),
                },
            });
        }
        return row;
    }
    /** 读取 shared secret 文件；env 未设置、文件缺失或不可读时返回 null（视为未配置）。 */
    async readSecretFile() {
        const file = process.env.VCPDECK_TURN_SECRET_FILE;
        if (!file)
            return null;
        try {
            return await (0, promises_1.readFile)(file, "utf8");
        }
        catch {
            return null;
        }
    }
    async secretConfigured() {
        const raw = await this.readSecretFile();
        return raw !== null && raw.trim().length > 0;
    }
    async requireSecret() {
        const raw = await this.readSecretFile();
        if (raw === null) {
            throw new TunnelConfigError("TUNNEL_TURN_NOT_CONFIGURED", "coturn shared secret 未就绪", 503);
        }
        const secret = raw.trim();
        if (secret.length === 0) {
            throw new TunnelConfigError("TUNNEL_TURN_NOT_CONFIGURED", "coturn shared secret 为空", 503);
        }
        return secret;
    }
};
exports.TunnelConfigService = TunnelConfigService;
exports.TunnelConfigService = TunnelConfigService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService])
], TunnelConfigService);
/** 安全解析 JSON 字符串数组；损坏时回退为空数组，不宽松猜测。 */
function parseJsonArray(json, field) {
    let parsed;
    try {
        parsed = JSON.parse(json || "[]");
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        return [];
    }
    return parsed;
}
