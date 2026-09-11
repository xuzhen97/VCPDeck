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
exports.AuthController = void 0;
const common_1 = require("@nestjs/common");
const auth_service_js_1 = require("./auth.service.js");
const public_decorator_js_1 = require("./public.decorator.js");
const actor_decorator_js_1 = require("./actor.decorator.js");
const COOKIE_SECURE = process.env.VCPDECK_COOKIE_SECURE !== "false";
const SESSION_TTL = parseInt(process.env.VCPDECK_SESSION_TTL_SECONDS || "604800", 10) * 1000;
let AuthController = class AuthController {
    authService;
    constructor(authService) {
        this.authService = authService;
    }
    async login(body, res) {
        try {
            const { sessionToken, identity } = await this.authService.login(body.username, body.password);
            res.cookie("vcpdeck_session", sessionToken, {
                httpOnly: true,
                secure: COOKIE_SECURE,
                sameSite: "strict",
                path: "/",
                maxAge: SESSION_TTL,
            });
            return { identity };
        }
        catch (e) {
            const code = e.message;
            if (code === "IDENTITY_DISABLED") {
                throw Object.assign(new Error("Identity disabled"), { statusCode: 401, code });
            }
            throw Object.assign(new Error("Invalid credentials"), { statusCode: 401, code: "AUTH_INVALID" });
        }
    }
    async logout(actor, res) {
        await this.authService.logout(actor);
        res.clearCookie("vcpdeck_session", { path: "/" });
        return { ok: true };
    }
    async getMe(actor) {
        return this.authService.getMe(actor);
    }
    async updateMe(actor, body) {
        try {
            await this.authService.updateMe(actor, body);
            return { ok: true };
        }
        catch (e) {
            if (e.message === "USERNAME_TAKEN") {
                throw Object.assign(new Error("Username already taken"), { statusCode: 409, code: "USERNAME_TAKEN" });
            }
            throw Object.assign(new Error("Invalid credentials"), { statusCode: 401, code: "AUTH_INVALID" });
        }
    }
    async createToken(actor, body) {
        return this.authService.createToken(actor, body.label);
    }
    async listTokens(actor) {
        return this.authService.listTokens(actor);
    }
    async revokeToken(actor, id) {
        await this.authService.revokeToken(actor, id);
        return { ok: true };
    }
};
exports.AuthController = AuthController;
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Post)("login"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "login", null);
__decorate([
    (0, common_1.Post)("logout"),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
__decorate([
    (0, common_1.Get)("me"),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "getMe", null);
__decorate([
    (0, common_1.Put)("me"),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "updateMe", null);
__decorate([
    (0, common_1.Post)("tokens"),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "createToken", null);
__decorate([
    (0, common_1.Get)("tokens"),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "listTokens", null);
__decorate([
    (0, common_1.Delete)("tokens/:id"),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __param(1, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "revokeToken", null);
exports.AuthController = AuthController = __decorate([
    (0, common_1.Controller)("api/auth"),
    __param(0, (0, common_1.Inject)(auth_service_js_1.AuthService)),
    __metadata("design:paramtypes", [auth_service_js_1.AuthService])
], AuthController);
