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
exports.AuthGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const public_decorator_js_1 = require("./public.decorator.js");
const node_crypto_1 = require("node:crypto");
function sha256(s) {
    return (0, node_crypto_1.createHash)("sha256").update(s).digest("hex");
}
let AuthGuard = class AuthGuard {
    reflector;
    prisma;
    constructor(reflector, prisma) {
        this.reflector = reflector;
        this.prisma = prisma;
    }
    async canActivate(context) {
        const isPublic = this.reflector.getAllAndOverride(public_decorator_js_1.IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic)
            return true;
        const req = context.switchToHttp().getRequest();
        const actor = await this.resolveActor(req);
        if (!actor) {
            throw new common_1.UnauthorizedException({
                statusCode: 401,
                code: "AUTH_REQUIRED",
                message: "Authentication required",
            });
        }
        req.actor = actor;
        return true;
    }
    async resolveActor(req) {
        // 1. Cookie session
        const sessionToken = req.cookies?.vcpdeck_session;
        if (sessionToken) {
            const hash = sha256(sessionToken);
            const session = await this.prisma.authSession.findUnique({ where: { sessionHash: hash } });
            if (session && !session.revokedAt && session.expiresAt > new Date()) {
                const identity = await this.prisma.identity.findUnique({ where: { id: session.identityId } });
                if (identity && !identity.disabledAt) {
                    return {
                        identityId: identity.id,
                        displayName: identity.displayName,
                        isAdmin: identity.isAdmin,
                        credentialId: null,
                        sessionId: session.id,
                        source: "web",
                        requestId: (0, node_crypto_1.randomUUID)(),
                    };
                }
            }
        }
        // 2. Bearer token
        const auth = req.headers?.authorization;
        if (auth?.startsWith("Bearer ")) {
            const token = auth.slice(7);
            const hash = sha256(token);
            const cred = await this.prisma.credential.findUnique({ where: { tokenHash: hash } });
            if (cred && !cred.revokedAt && (!cred.expiresAt || cred.expiresAt > new Date())) {
                const identity = await this.prisma.identity.findUnique({ where: { id: cred.identityId } });
                if (identity && !identity.disabledAt) {
                    return {
                        identityId: identity.id,
                        displayName: identity.displayName,
                        isAdmin: identity.isAdmin,
                        credentialId: cred.id,
                        sessionId: null,
                        source: "cli",
                        requestId: (0, node_crypto_1.randomUUID)(),
                    };
                }
            }
        }
        return null;
    }
};
exports.AuthGuard = AuthGuard;
exports.AuthGuard = AuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(core_1.Reflector)),
    __param(1, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [core_1.Reflector, prisma_service_js_1.PrismaService])
], AuthGuard);
