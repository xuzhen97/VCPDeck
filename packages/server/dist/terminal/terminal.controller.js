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
exports.TerminalController = void 0;
const common_1 = require("@nestjs/common");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
const terminal_service_js_1 = require("./terminal.service.js");
const terminal_audit_service_js_1 = require("./terminal-audit.service.js");
const shared_1 = require("@vcpdeck/shared");
/** 稳定错误码 → HTTP 状态映射。 */
const TERMINAL_HTTP_STATUS = {
    TERMINAL_PROTOCOL_INVALID: 400,
    TERMINAL_INPUT_TOO_LARGE: 400,
    TERMINAL_SESSION_NOT_FOUND: 404,
    TERMINAL_SESSION_ENDED: 409,
    TERMINAL_SESSION_LIMIT_REACHED: 409,
    TERMINAL_READ_ONLY: 409,
    TERMINAL_CONTROL_PROTECTED: 409,
    TERMINAL_CONTROL_CONFLICT: 409,
    TERMINAL_PTY_SPAWN_FAILED: 422,
    TERMINAL_SNAPSHOT_FAILED: 422,
    TERMINAL_CLIENT_OFFLINE: 503,
    TERMINAL_UNSUPPORTED: 503,
    TERMINAL_NATIVE_BACKEND_UNAVAILABLE: 503,
    TERMINAL_REQUEST_TIMEOUT: 504,
};
function mapTerminalError(error) {
    const code = error.code;
    const stableCode = typeof code === "string" ? code : "TERMINAL_UNKNOWN";
    const status = TERMINAL_HTTP_STATUS[stableCode] ?? 500;
    // 未知错误不泄露内部细节；已知错误使用安全文案
    const message = status === 500
        ? "Terminal operation failed"
        : (0, shared_1.safeTerminalErrorMessage)(error.message);
    if (status === 404)
        return new common_1.NotFoundException({ code: stableCode, message });
    if (status === 409)
        return new common_1.ConflictException({ code: stableCode, message });
    if (status === 503)
        return new common_1.ServiceUnavailableException({ code: stableCode, message });
    if (status === 400)
        return new common_1.BadRequestException({ code: stableCode, message });
    return new common_1.HttpException({ code: stableCode, message }, status);
}
function page(value, fallback) {
    if (value === undefined)
        return fallback;
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < 1)
        return fallback;
    return n;
}
/** 终端会话 REST API（机器范围内）。 */
let TerminalController = class TerminalController {
    service;
    auditService;
    constructor(service, auditService) {
        this.service = service;
        this.auditService = auditService;
    }
    async shells(clientId, _actor) {
        try {
            return await this.service.listShells(clientId);
        }
        catch (error) {
            throw mapTerminalError(error);
        }
    }
    async list(clientId, pageStr = undefined, pageSizeStr = undefined, _actor) {
        const pageSize = Math.min(100, page(pageSizeStr, 20));
        try {
            return await this.service.listSessions(clientId, page(pageStr, 1), pageSize);
        }
        catch (error) {
            throw mapTerminalError(error);
        }
    }
    async create(clientId, body, actor) {
        let parsed;
        try {
            parsed = (0, shared_1.parseTerminalSessionCreateRequest)(body);
        }
        catch {
            throw new common_1.BadRequestException({
                code: "TERMINAL_PROTOCOL_INVALID",
                message: "Invalid terminal create request",
            });
        }
        try {
            return await this.service.createSession(clientId, parsed, actor);
        }
        catch (error) {
            throw mapTerminalError(error);
        }
    }
    async get(clientId, sessionId, _actor) {
        try {
            return await this.service.getSession(clientId, sessionId);
        }
        catch (error) {
            throw mapTerminalError(error);
        }
    }
    async remove(clientId, sessionId, actor) {
        try {
            return await this.service.closeSession(clientId, sessionId, actor);
        }
        catch (error) {
            throw mapTerminalError(error);
        }
    }
    async audit(clientId, sessionId, pageStr = undefined, pageSizeStr = undefined, _actor) {
        const pageSize = Math.min(100, page(pageSizeStr, 20));
        try {
            await this.service.getSession(clientId, sessionId);
            return await this.auditService.list({ sessionId, clientId }, page(pageStr, 1), pageSize);
        }
        catch (error) {
            throw mapTerminalError(error);
        }
    }
};
exports.TerminalController = TerminalController;
__decorate([
    (0, common_1.Get)("shells"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], TerminalController.prototype, "shells", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Query)("page")),
    __param(2, (0, common_1.Query)("pageSize")),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], TerminalController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], TerminalController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(":sessionId"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], TerminalController.prototype, "get", null);
__decorate([
    (0, common_1.Delete)(":sessionId"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], TerminalController.prototype, "remove", null);
__decorate([
    (0, common_1.Get)(":sessionId/audit"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Query)("page")),
    __param(3, (0, common_1.Query)("pageSize")),
    __param(4, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], TerminalController.prototype, "audit", null);
exports.TerminalController = TerminalController = __decorate([
    (0, common_1.Controller)("api/clients/:clientId/terminals"),
    __param(0, (0, common_1.Inject)(terminal_service_js_1.TerminalService)),
    __param(1, (0, common_1.Inject)(terminal_audit_service_js_1.TerminalAuditService)),
    __metadata("design:paramtypes", [terminal_service_js_1.TerminalService, terminal_audit_service_js_1.TerminalAuditService])
], TerminalController);
