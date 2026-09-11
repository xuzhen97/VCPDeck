"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const node_crypto_1 = require("node:crypto");
const bcrypt = __importStar(require("bcryptjs"));
function sha256(s) {
    return (0, node_crypto_1.createHash)("sha256").update(s).digest("hex");
}
function generateToken() {
    return "vcp_" + (0, node_crypto_1.randomBytes)(32).toString("hex");
}
const SESSION_TTL = parseInt(process.env.VCPDECK_SESSION_TTL_SECONDS || "604800", 10);
let AuthService = class AuthService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async login(username, password) {
        const identity = await this.prisma.identity.findUnique({ where: { username } });
        if (!identity) {
            throw new Error("AUTH_INVALID");
        }
        if (identity.disabledAt) {
            throw new Error("IDENTITY_DISABLED");
        }
        const valid = await bcrypt.compare(password, identity.passwordHash);
        if (!valid) {
            throw new Error("AUTH_INVALID");
        }
        const sessionToken = (0, node_crypto_1.randomBytes)(32).toString("hex");
        await this.prisma.authSession.create({
            data: {
                id: (0, node_crypto_1.randomUUID)(),
                identityId: identity.id,
                sessionHash: sha256(sessionToken),
                expiresAt: new Date(Date.now() + SESSION_TTL * 1000),
            },
        });
        return {
            sessionToken,
            identity: {
                id: identity.id,
                username: identity.username,
                displayName: identity.displayName,
                isAdmin: identity.isAdmin,
            },
        };
    }
    async logout(actor) {
        if (actor.sessionId) {
            await this.prisma.authSession.update({
                where: { id: actor.sessionId },
                data: { revokedAt: new Date() },
            });
        }
    }
    async getMe(actor) {
        const identity = await this.prisma.identity.findUnique({ where: { id: actor.identityId } });
        if (!identity)
            throw new Error("AUTH_INVALID");
        return {
            id: identity.id,
            username: identity.username,
            displayName: identity.displayName,
            isAdmin: identity.isAdmin,
            disabledAt: identity.disabledAt?.toISOString() ?? null,
            createdAt: identity.createdAt.toISOString(),
        };
    }
    async updateMe(actor, data) {
        const identity = await this.prisma.identity.findUnique({ where: { id: actor.identityId } });
        if (!identity)
            throw new Error("AUTH_INVALID");
        const valid = await bcrypt.compare(data.currentPassword, identity.passwordHash);
        if (!valid) {
            throw new Error("AUTH_INVALID");
        }
        const updateData = {};
        if (data.username) {
            const existing = await this.prisma.identity.findUnique({ where: { username: data.username } });
            if (existing && existing.id !== identity.id) {
                throw new Error("USERNAME_TAKEN");
            }
            updateData.username = data.username;
        }
        if (data.password) {
            updateData.passwordHash = await bcrypt.hash(data.password, 10);
        }
        if (Object.keys(updateData).length > 0) {
            await this.prisma.identity.update({ where: { id: actor.identityId }, data: updateData });
        }
    }
    async createToken(actor, label) {
        const token = generateToken();
        const id = (0, node_crypto_1.randomUUID)();
        await this.prisma.credential.create({
            data: {
                id,
                identityId: actor.identityId,
                label,
                tokenHash: sha256(token),
            },
        });
        return { id, token, label };
    }
    async listTokens(actor) {
        const creds = await this.prisma.credential.findMany({
            where: { identityId: actor.identityId },
            orderBy: { createdAt: "desc" },
        });
        return creds.map((c) => ({
            id: c.id,
            label: c.label,
            lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
            expiresAt: c.expiresAt?.toISOString() ?? null,
            revokedAt: c.revokedAt?.toISOString() ?? null,
            createdAt: c.createdAt.toISOString(),
        }));
    }
    async revokeToken(actor, credentialId) {
        const cred = await this.prisma.credential.findUnique({ where: { id: credentialId } });
        if (!cred || cred.identityId !== actor.identityId) {
            throw new Error("AUTH_INVALID");
        }
        await this.prisma.credential.update({
            where: { id: credentialId },
            data: { revokedAt: new Date() },
        });
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService])
], AuthService);
