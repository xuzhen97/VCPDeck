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
exports.IdentityService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const node_crypto_1 = require("node:crypto");
const bcrypt = __importStar(require("bcryptjs"));
let IdentityService = class IdentityService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(username, password, displayName) {
        const existing = await this.prisma.identity.findUnique({ where: { username } });
        if (existing) {
            throw Object.assign(new Error("Username already taken"), { statusCode: 409, code: "USERNAME_TAKEN" });
        }
        const identity = await this.prisma.identity.create({
            data: {
                id: (0, node_crypto_1.randomUUID)(),
                username,
                displayName,
                passwordHash: await bcrypt.hash(password, 10),
            },
        });
        return toInfo(identity);
    }
    async list() {
        const identities = await this.prisma.identity.findMany({ orderBy: { createdAt: "desc" } });
        return identities.map(toInfo);
    }
    async disable(id) {
        await this.prisma.identity.update({ where: { id }, data: { disabledAt: new Date() } });
        // 撤销所有 session
        await this.prisma.authSession.updateMany({
            where: { identityId: id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    }
    async enable(id) {
        await this.prisma.identity.update({ where: { id }, data: { disabledAt: null } });
    }
};
exports.IdentityService = IdentityService;
exports.IdentityService = IdentityService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService])
], IdentityService);
function toInfo(i) {
    return {
        id: i.id,
        username: i.username,
        displayName: i.displayName,
        isAdmin: i.isAdmin,
        disabledAt: i.disabledAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
    };
}
