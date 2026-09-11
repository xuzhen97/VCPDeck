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
exports.ServerDrain = void 0;
/**
 * 服务端优雅停机闸门：停止新派发并等待运行中 job 收敛。
 * 详见 docs/design/release-and-update.md。
 */
const common_1 = require("@nestjs/common");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
let ServerDrain = class ServerDrain {
    prisma;
    draining = false;
    pollIntervalMs;
    timeoutMs;
    constructor(prisma, 
    // 可调参数不是 DI 依赖
    options = {}) {
        this.prisma = prisma;
        this.pollIntervalMs = options.pollIntervalMs ?? 1000;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    /** 是否处于停机收敛中（JobScheduler 据此拒绝新派发） */
    isDraining() {
        return this.draining;
    }
    /**
     * 置闸门并等待所有 running/waiting_input job 收敛为终态。
     * 超时抛错（不解除闸门；此时进程即将被 launcher 接管）。
     */
    async drain(timeoutMs = this.timeoutMs) {
        this.draining = true;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const running = await this.prisma.job.count({
                where: { status: { in: ["running", "waiting_input"] } },
            });
            if (running === 0)
                return;
            if (Date.now() >= deadline) {
                throw new Error(`等待 job 收敛超时（仍有 ${running} 个运行中）`);
            }
            await sleep(this.pollIntervalMs);
        }
    }
};
exports.ServerDrain = ServerDrain;
exports.ServerDrain = ServerDrain = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, Object])
], ServerDrain);
