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
exports.TerminalAuditService = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const terminal_records_js_1 = require("./terminal-records.js");
/** 终端最小审计：只记录生命周期事件，不记录输入输出。 */
let TerminalAuditService = class TerminalAuditService {
    prisma;
    // 显式 @Inject：tsx/esbuild 转译不 emit decorator metadata，无 @Inject 的类型注入会得到 undefined
    constructor(prisma) {
        this.prisma = prisma;
    }
    async record(request) {
        if (!shared_1.TERMINAL_AUDIT_EVENTS.includes(request.event)) {
            throw new Error("audit event not allowed");
        }
        await this.prisma.terminalAuditEvent.create({
            data: {
                id: `ta_${(0, node_crypto_1.randomUUID)()}`,
                sessionId: request.sessionId,
                clientId: request.clientId,
                event: request.event,
                identityId: request.identityId,
                actorName: request.actorName,
                source: request.source,
                result: request.result,
                reason: request.reason ?? null,
            },
        });
    }
    /** 分页审计列表（遵循 PaginatedResult 规范）。 */
    async list(filter, page = 1, pageSize = 20) {
        const where = {};
        if (filter.sessionId)
            where.sessionId = filter.sessionId;
        if (filter.clientId)
            where.clientId = filter.clientId;
        const [list, total] = await Promise.all([
            this.prisma.terminalAuditEvent.findMany({
                where,
                orderBy: { createdAt: "desc" },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.prisma.terminalAuditEvent.count({ where }),
        ]);
        return {
            data: list.map((r) => (0, terminal_records_js_1.toTerminalAuditInfo)(r)),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
};
exports.TerminalAuditService = TerminalAuditService;
exports.TerminalAuditService = TerminalAuditService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService])
], TerminalAuditService);
