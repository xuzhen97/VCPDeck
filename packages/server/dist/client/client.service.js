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
exports.ClientService = exports.CLIENT_HEARTBEAT_TIMEOUT_MS = exports.INVALID_CLIENT_NAME = exports.CLIENT_NOT_FOUND = exports.CLIENT_NAME_TAKEN = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const shared_1 = require("@vcpdeck/shared");
/** 别名已被其他客户端占用（409） */
exports.CLIENT_NAME_TAKEN = "CLIENT_NAME_TAKEN";
/** 客户端不存在（404） */
exports.CLIENT_NOT_FOUND = "CLIENT_NOT_FOUND";
/** 别名为空（400） */
exports.INVALID_CLIENT_NAME = "INVALID_CLIENT_NAME";
/** Client 心跳超时阈值：超过两个以上心跳周期未上报即视为离线。 */
exports.CLIENT_HEARTBEAT_TIMEOUT_MS = 30_000;
/** 服务层错误：稳定 code + statusCode，由 Controller 映射为 HttpException */
function clientError(code, message, statusCode) {
    return Object.assign(new Error(message), { code, statusCode });
}
let ClientService = class ClientService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async register(dto, socketId) {
        // 持久化契约：capabilityDetails JSON 列同时承载 pi/terminal/frp/privileged 探测摘要
        // 与 installation 安装模式摘要（旧 Client 无 installation 字段时不写入，不推断）。
        const storedDetails = { ...(dto.capabilityDetails ?? {}) };
        if (dto.installation !== undefined) {
            storedDetails.installation = dto.installation;
        }
        const capabilityDetails = JSON.stringify(storedDetails);
        const common = {
            hostname: dto.hostname,
            os: dto.os,
            cpuModel: dto.cpuModel,
            totalMemMB: dto.totalMemMB,
            clientVersion: dto.clientVersion,
            capabilities: JSON.stringify(dto.capabilities),
            capabilityDetails,
            online: true,
            lastHeartbeatAt: new Date(),
            socketId,
            connectedAt: new Date(),
        };
        // 别名策略：新机器首次注册生成唯一别名（默认 hostname，重名自动加后缀）；
        // 已有记录保持别名不动（迁移前的旧记录 name 为 null 时在此补齐）
        const existing = await this.prisma.client.findUnique({
            where: { id: dto.clientId },
            select: { name: true },
        });
        const name = existing?.name ?? (await this.nextAvailableName(dto.hostname));
        await this.prisma.client.upsert({
            where: { id: dto.clientId },
            create: { ...common, id: dto.clientId, name },
            update: existing?.name ? common : { ...common, name },
        });
    }
    /**
     * 生成全局唯一别名：优先 base，被占用则依次尝试 base_1、base_2 …
     * 并发注册同名机器的极小竞态由 name 唯一索引兜底（失败方下次重连自愈）。
     */
    async nextAvailableName(base) {
        const clean = base.trim() || "client";
        for (let i = 0; i < 1000; i++) {
            const candidate = i === 0 ? clean : `${clean}_${i}`;
            const hit = await this.prisma.client.findFirst({
                where: { name: candidate },
                select: { id: true },
            });
            if (!hit)
                return candidate;
        }
        throw clientError("CLIENT_NAME_UNAVAILABLE", `No available name for "${base}"`, 409);
    }
    /** 修改别名：必须全局唯一；改名立即生效，机器下次重连不会覆盖 */
    async rename(clientId, name) {
        const clean = name.trim();
        if (!clean) {
            throw clientError(exports.INVALID_CLIENT_NAME, "Client name must be a non-empty string", 400);
        }
        const taken = await this.prisma.client.findFirst({
            where: { name: clean, id: { not: clientId } },
            select: { id: true },
        });
        if (taken) {
            throw clientError(exports.CLIENT_NAME_TAKEN, `Client name "${clean}" is already taken`, 409);
        }
        let updated;
        try {
            updated = await this.prisma.client.update({
                where: { id: clientId },
                data: { name: clean },
            });
        }
        catch (error) {
            // P2025: 目标记录不存在
            if (error?.code === "P2025") {
                throw clientError(exports.CLIENT_NOT_FOUND, `Client "${clientId}" not found`, 404);
            }
            throw error;
        }
        return this.toClientInfo(updated);
    }
    async heartbeat(dto) {
        await this.prisma.client.update({
            where: { id: dto.clientId },
            data: {
                lastHeartbeatAt: new Date(),
                cpuPercent: dto.cpuPercent,
                memPercent: dto.memPercent,
                disks: JSON.stringify(dto.disks),
                runningJobs: JSON.stringify(dto.runningJobs),
            },
        });
    }
    /** 原子收敛心跳超时的 Client，返回实际成功收敛的 socket lease。 */
    async expireStaleClients(now = new Date()) {
        const cutoff = new Date(now.getTime() - exports.CLIENT_HEARTBEAT_TIMEOUT_MS);
        const staleWhere = {
            online: true,
            OR: [
                { lastHeartbeatAt: { lt: cutoff } },
                { lastHeartbeatAt: null, connectedAt: { lt: cutoff } },
            ],
        };
        const candidates = await this.prisma.client.findMany({
            where: staleWhere,
            select: { id: true, socketId: true },
        });
        const expired = [];
        for (const candidate of candidates) {
            const result = await this.prisma.client.updateMany({
                where: { ...staleWhere, id: candidate.id, socketId: candidate.socketId },
                data: { online: false, socketId: null },
            });
            if (result.count > 0) {
                expired.push({ clientId: candidate.id, socketId: candidate.socketId });
            }
        }
        return expired;
    }
    /** Re-bind socketId on reconnect without overwriting machine info. */
    async bindSocket(clientId, socketId) {
        await this.prisma.client.update({
            where: { id: clientId },
            data: { online: true, lastHeartbeatAt: new Date(), socketId, connectedAt: new Date() },
        });
    }
    async getClientIdBySocketId(socketId) {
        const c = await this.prisma.client.findFirst({ where: { socketId } });
        return c?.id ?? null;
    }
    async markOfflineBySocketId(socketId) {
        await this.prisma.client.updateMany({
            where: { socketId },
            data: { online: false, socketId: null },
        });
    }
    async listOnline() {
        const clients = await this.prisma.client.findMany({
            where: { online: true },
            orderBy: { connectedAt: "desc" },
        });
        return clients.map((c) => this.toClientInfo(c));
    }
    /** 返回一键安装器所需的最小 Client 验收摘要。 */
    async getInstallerStatus(clientId) {
        const client = await this.prisma.client.findUnique({ where: { id: clientId } });
        if (!client) {
            return {
                registered: false,
                online: false,
                clientVersion: null,
                name: null,
                hostname: null,
                capabilitiesReported: false,
                installationMode: null,
                nonInteractiveSudo: null,
                connectedAt: null,
                lastHeartbeatAt: null,
            };
        }
        let capabilities = [];
        try {
            capabilities = JSON.parse(client.capabilities);
        }
        catch {
            // 损坏数据按未完成能力上报处理。
        }
        const stored = client.capabilityDetails
            ? this.parseStoredDetails(client.capabilityDetails)
            : { details: {}, installation: null };
        return {
            registered: true,
            online: client.online,
            clientVersion: client.clientVersion,
            name: client.name ?? client.hostname,
            hostname: client.hostname,
            capabilitiesReported: Array.isArray(capabilities) && capabilities.length > 0,
            installationMode: stored.installation?.mode ?? null,
            nonInteractiveSudo: stored.details.privileged?.nonInteractive ?? null,
            connectedAt: client.connectedAt?.toISOString() ?? null,
            lastHeartbeatAt: client.lastHeartbeatAt?.toISOString() ?? null,
        };
    }
    toClientInfo(c) {
        let capabilities = [];
        try {
            capabilities = JSON.parse(c.capabilities);
        }
        catch {
            // ponytail: stored as JSON, fallback to empty on corruption
        }
        let disks = [];
        try {
            disks = JSON.parse(c.disks);
        }
        catch {
            // ponytail: stored as JSON, fallback to empty on corruption
        }
        const { details: capabilityDetails, installation } = this.parseStoredDetails(c.capabilityDetails);
        const info = {
            clientId: c.id,
            name: c.name ?? c.hostname,
            hostname: c.hostname,
            os: c.os,
            cpuModel: c.cpuModel,
            totalMemMB: c.totalMemMB,
            clientVersion: c.clientVersion,
            capabilities,
            capabilityDetails,
            online: c.online,
            cpuPercent: c.cpuPercent ?? null,
            memPercent: c.memPercent ?? null,
            disks,
            lastHeartbeatAt: c.lastHeartbeatAt?.toISOString() ?? null,
        };
        if (installation !== null) {
            info.installation = installation;
        }
        return info;
    }
    /**
     * 严格解析持久化的 capabilityDetails JSON 列。
     * 逐字段投影；损坏/未知字段省略，不宽松猜测（缺失 = 未报告，不推断为任何模式）。
     */
    parseStoredDetails(json) {
        const result = { details: {}, installation: null };
        let raw;
        try {
            raw = JSON.parse(json);
        }
        catch {
            // 整体损坏：回退为空能力详情，不宽松猜测。
            return result;
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            return result;
        const record = raw;
        if (record.pi !== undefined) {
            // 沿用既有行为：pi 摘要透传（与 ADR-0023 前的投影一致，不放宽也不新增加严）。
            result.details.pi = record.pi;
        }
        if (record.terminal !== undefined) {
            result.details.terminal = record.terminal;
        }
        if (record.frp !== undefined) {
            try {
                result.details.frp = (0, shared_1.parseFrpCapabilityStatus)(record.frp);
            }
            catch {
                // frp 详情损坏：省略该字段，不宽松猜测（旧 Client 缺省时无此字段）。
            }
        }
        if (record.privileged !== undefined) {
            try {
                result.details.privileged = (0, shared_1.parsePrivilegedCapabilityStatus)(record.privileged);
            }
            catch {
                // privileged 摘要损坏：省略，UI 显示“未报告”，不推断为 root 等价。
            }
        }
        if (record.installation !== undefined) {
            try {
                result.installation = (0, shared_1.parseMachineInstallation)(record.installation);
            }
            catch {
                // installation 摘要损坏：省略，不宽松猜测。
            }
        }
        return result;
    }
};
exports.ClientService = ClientService;
exports.ClientService = ClientService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService])
], ClientService);
