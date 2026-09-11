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
exports.JobScheduler = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const server_drain_js_1 = require("./server-drain.js");
function safeJsonParse(raw, fallback) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
const MAX_CONCURRENT_JOBS = 3;
let JobScheduler = class JobScheduler {
    prisma;
    drain;
    constructor(prisma, 
    // 优雅停机闸门：JobModule 提供；测试可不传
    drain) {
        this.prisma = prisma;
        this.drain = drain;
    }
    async tryDispatch(clientId) {
        if (this.drain?.isDraining())
            return null;
        const runningCount = await this.prisma.job.count({
            where: {
                clientId,
                status: "running",
                type: { notIn: ["agent.run", "agent.session"] },
            },
        });
        if (runningCount >= MAX_CONCURRENT_JOBS)
            return null;
        const pending = await this.prisma.job.findFirst({
            where: {
                clientId,
                status: "pending",
                type: { notIn: ["agent.run", "agent.session"] },
            },
            orderBy: { createdAt: "asc" },
        });
        if (!pending)
            return null;
        await this.prisma.job.update({
            where: { id: pending.id },
            data: { status: "running", startedAt: new Date() },
        });
        return {
            jobId: pending.id,
            clientId: pending.clientId,
            type: pending.type,
            payload: safeJsonParse(pending.payload, {}),
            timeout: pending.timeout ?? undefined,
        };
    }
    async onFinished(clientId) {
        return this.tryDispatch(clientId);
    }
};
exports.JobScheduler = JobScheduler;
exports.JobScheduler = JobScheduler = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Optional)()),
    __param(1, (0, common_1.Inject)(server_drain_js_1.ServerDrain)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, server_drain_js_1.ServerDrain])
], JobScheduler);
