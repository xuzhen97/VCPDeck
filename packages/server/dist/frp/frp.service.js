"use strict";
/** @file FRP 映射服务 — 持久化、端口分配与 Dashboard 收敛 */
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
exports.FrpService = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const frp_instances_service_js_1 = require("./frp-instances.service.js");
const frp_reconciliation_service_js_1 = require("./frp-reconciliation.service.js");
const port_allocator_js_1 = require("./port-allocator.js");
/** FRP 映射操作稳定失败。 */
class FrpOperationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "FrpOperationError";
    }
}
function buildPublicUrl(remotePort, proxyType, customDomain, serverAddr) {
    if (proxyType === "tcp") {
        return remotePort === null ? null : `${serverAddr}:${remotePort}`;
    }
    return customDomain ? `${proxyType}://${customDomain}` : null;
}
let FrpService = class FrpService {
    prisma;
    instancesService;
    reconciliation;
    allocator;
    constructor(prisma, instancesService, 
    /** 恢复周期互斥守卫；未注入时（旧测试直接两参构造）跳过检查。 */
    reconciliation) {
        this.prisma = prisma;
        this.instancesService = instancesService;
        this.reconciliation = reconciliation;
        this.allocator = new port_allocator_js_1.PortAllocator(prisma);
    }
    async createMapping(dto) {
        // 恢复周期内拒绝写操作（稳定 FRP_RECONCILE_BUSY / 409）。
        this.reconciliation?.assertWritable(dto.clientId);
        const client = await this.prisma.client.findUnique({
            where: { id: dto.clientId },
        });
        if (!client) {
            const e = new Error(`Client "${dto.clientId}" 不存在`);
            e.code = "FRP_CLIENT_NOT_FOUND";
            throw e;
        }
        if (!client.online) {
            const e = new Error(`Client "${dto.clientId}" 不在线`);
            e.code = "FRP_CLIENT_OFFLINE";
            throw e;
        }
        let capabilities = [];
        try {
            capabilities = JSON.parse(client.capabilities);
        }
        catch {
            capabilities = [];
        }
        if (!capabilities.includes("frp")) {
            const e = new Error(`Client "${dto.clientId}" 未启用 FRP 能力`);
            e.code = "FRP_CLIENT_NO_FRP_CAPABILITY";
            throw e;
        }
        const instance = dto.frpsInstanceId
            ? await this.instancesService.getById(dto.frpsInstanceId)
            : await this.instancesService.getDefault();
        if (!instance)
            throw new Error("未找到目标 FRP 实例");
        const clientMapping = await this.prisma.frpMapping.findFirst({
            where: { clientId: dto.clientId },
            select: { frpsInstanceId: true },
        });
        if (clientMapping?.frpsInstanceId &&
            clientMapping.frpsInstanceId !== instance.id) {
            throw new Error("同一 Client 当前只能使用一个 FRPS 实例");
        }
        const dashboard = await this.instancesService.listDashboardProxies(instance);
        const id = `fm_${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
        const name = await this.resolveName(instance.id, dto.name, `${dto.proxyType}-${dto.localPort}`, id, dashboard.list.map((proxy) => proxy.name));
        const remotePort = dto.proxyType === "tcp"
            ? await this.allocator.allocate({
                preferredPort: dto.remotePort,
                portRangeStart: instance.portRangeStart,
                portRangeEnd: instance.portRangeEnd,
                usedPorts: dashboard.usedPorts,
            })
            : null;
        const jobId = (0, node_crypto_1.randomUUID)();
        const timeoutSeconds = dto.timeoutSeconds ?? 30;
        const publicUrl = buildPublicUrl(remotePort, dto.proxyType, dto.customDomain ?? null, instance.serverAddr);
        const payload = {
            mappingId: id,
            name,
            proxyType: dto.proxyType,
            localIp: dto.localIp ?? "127.0.0.1",
            localPort: dto.localPort,
            ...(remotePort === null ? {} : { remotePort }),
            ...(dto.customDomain ? { customDomain: dto.customDomain } : {}),
            frpsInfo: {
                serverAddr: instance.serverAddr,
                serverPort: instance.serverPort,
                authToken: instance.authToken,
            },
        };
        const row = await this.prisma.$transaction(async (transaction) => {
            await transaction.job.create({
                data: {
                    id: jobId,
                    clientId: dto.clientId,
                    type: "frp.create",
                    status: "running",
                    startedAt: new Date(),
                    payload: JSON.stringify(payload),
                    timeout: timeoutSeconds,
                },
            });
            return transaction.frpMapping.create({
                data: {
                    id,
                    clientId: dto.clientId,
                    frpsInstanceId: instance.id,
                    name,
                    proxyType: dto.proxyType,
                    localIp: dto.localIp ?? "127.0.0.1",
                    localPort: dto.localPort,
                    remotePort,
                    customDomain: dto.customDomain ?? null,
                    status: "provisioning",
                    publicUrl,
                    operationJobId: jobId,
                    operationTimeoutSeconds: timeoutSeconds,
                    errorCode: null,
                    errorMessage: null,
                },
            });
        });
        return {
            mapping: this.toApi(row),
            dispatch: {
                clientId: dto.clientId,
                jobId,
                type: "frp.create",
                // SAFETY: payload 由上方固定协议字段组成，全部可 JSON 序列化。
                payload: payload,
                timeout: timeoutSeconds,
            },
        };
    }
    async deleteMapping(id, timeoutSeconds = 30) {
        const mapping = await this.prisma.frpMapping.findUnique({ where: { id } });
        if (!mapping)
            return null;
        // 恢复周期内拒绝写操作（稳定 FRP_RECONCILE_BUSY / 409）。
        this.reconciliation?.assertWritable(mapping.clientId);
        const client = await this.prisma.client.findUnique({
            where: { id: mapping.clientId },
            select: { online: true },
        });
        if (!client?.online) {
            const e = new Error(`Client "${mapping.clientId}" 不在线`);
            e.code = "FRP_CLIENT_OFFLINE";
            throw e;
        }
        const payload = { mappingId: id, name: mapping.name };
        const jobId = (0, node_crypto_1.randomUUID)();
        const row = await this.prisma.$transaction(async (transaction) => {
            await transaction.job.create({
                data: {
                    id: jobId,
                    clientId: mapping.clientId,
                    type: "frp.delete",
                    status: "running",
                    startedAt: new Date(),
                    payload: JSON.stringify(payload),
                    timeout: timeoutSeconds,
                },
            });
            return transaction.frpMapping.update({
                where: { id },
                data: {
                    status: "deleting",
                    operationJobId: jobId,
                    operationTimeoutSeconds: timeoutSeconds,
                    errorCode: null,
                    errorMessage: null,
                },
            });
        });
        return {
            mapping: this.toApi(row),
            dispatch: {
                clientId: mapping.clientId,
                jobId,
                type: "frp.delete",
                // SAFETY: FrpDeletePayload 只包含 mappingId/name 字符串。
                payload: payload,
                timeout: timeoutSeconds,
            },
        };
    }
    /** Client 本地 FRP 动作完成后，以 Dashboard 状态收敛操作。 */
    async settleClientOperation(jobId, type) {
        const job = await this.prisma.job.findUnique({ where: { id: jobId } });
        if (!job || job.type !== type) {
            throw new Error(`FRP Job "${jobId}" 不存在或类型不匹配`);
        }
        let payload;
        try {
            payload = JSON.parse(job.payload);
        }
        catch {
            throw new Error(`FRP Job "${jobId}" payload 无效`);
        }
        if (!payload.mappingId || !payload.name) {
            throw new Error(`FRP Job "${jobId}" payload 无效`);
        }
        const mapping = await this.prisma.frpMapping.findUnique({
            where: { id: payload.mappingId },
            select: {
                id: true,
                clientId: true,
                frpsInstanceId: true,
                name: true,
                proxyType: true,
                operationTimeoutSeconds: true,
                errorCode: true,
                errorMessage: true,
            },
        });
        if (!mapping) {
            return {
                terminal: true,
                result: { mappingId: payload.mappingId, deleted: true },
            };
        }
        if (!mapping.frpsInstanceId) {
            throw new FrpOperationError("FRPS_DASHBOARD_REQUIRED", "映射未关联 FRPS 实例");
        }
        const instance = await this.instancesService.getById(mapping.frpsInstanceId);
        if (!instance)
            throw new Error("映射关联的 FRPS 实例不存在");
        const shouldExist = type === "frp.create";
        let confirmed = false;
        let dashboardError;
        try {
            confirmed = await this.waitForProxy(instance, mapping.proxyType, mapping.name, shouldExist, mapping.operationTimeoutSeconds);
        }
        catch (error) {
            const failure = error;
            dashboardError = {
                code: failure.code ?? "FRPS_DASHBOARD_UNREACHABLE",
                message: failure.message ?? "FRPS Dashboard 不可达",
            };
        }
        if (confirmed && shouldExist) {
            await this.prisma.frpMapping.update({
                where: { id: mapping.id },
                data: {
                    status: "active",
                    operationJobId: null,
                    errorCode: null,
                    errorMessage: null,
                },
            });
            return {
                terminal: true,
                result: { mappingId: mapping.id, status: "active" },
            };
        }
        if (confirmed) {
            await this.prisma.frpMapping.delete({ where: { id: mapping.id } });
            const result = { mappingId: mapping.id, deleted: true };
            if (!payload.rollbackOfJobId)
                return { terminal: true, result };
            return {
                terminal: true,
                result,
                relatedJob: {
                    jobId: payload.rollbackOfJobId,
                    errorCode: mapping.errorCode ??
                        "FRP_PROXY_CONFIRM_TIMEOUT",
                    errorMessage: mapping.errorMessage ??
                        "FRPS 未在时限内确认 proxy 注册；已自动回滚",
                },
            };
        }
        if (shouldExist) {
            const rollbackJobId = (0, node_crypto_1.randomUUID)();
            const rollbackPayload = {
                mappingId: mapping.id,
                name: mapping.name,
                rollbackOfJobId: jobId,
            };
            await this.prisma.job.create({
                data: {
                    id: rollbackJobId,
                    clientId: mapping.clientId,
                    type: "frp.delete",
                    status: "running",
                    startedAt: new Date(),
                    payload: JSON.stringify(rollbackPayload),
                    timeout: mapping.operationTimeoutSeconds,
                },
            });
            await this.prisma.frpMapping.update({
                where: { id: mapping.id },
                data: {
                    status: "deleting",
                    operationJobId: rollbackJobId,
                    errorCode: dashboardError?.code ?? "FRP_PROXY_CONFIRM_TIMEOUT",
                    errorMessage: dashboardError?.message ??
                        "FRPS 未在时限内确认 proxy 注册，正在回滚",
                },
            });
            return {
                terminal: false,
                dispatch: {
                    jobId: rollbackJobId,
                    clientId: mapping.clientId,
                    type: "frp.delete",
                    payload: { ...rollbackPayload },
                    timeout: mapping.operationTimeoutSeconds,
                },
            };
        }
        const rollback = Boolean(payload.rollbackOfJobId);
        const errorCode = rollback
            ? "FRP_ROLLBACK_FAILED"
            : dashboardError?.code ?? "FRP_PROXY_REMOVE_TIMEOUT";
        const errorMessage = rollback
            ? "创建失败后的 FRP proxy 回滚未完成"
            : dashboardError?.message ?? "FRPS 未在时限内确认 proxy 消失";
        await this.prisma.frpMapping.update({
            where: { id: mapping.id },
            data: {
                status: "error",
                operationJobId: null,
                errorCode,
                errorMessage,
            },
        });
        return {
            terminal: true,
            result: { mappingId: mapping.id },
            errorCode,
            errorMessage,
            ...(payload.rollbackOfJobId
                ? {
                    relatedJob: {
                        jobId: payload.rollbackOfJobId,
                        errorCode,
                        errorMessage,
                    },
                }
                : {}),
        };
    }
    /** Client 本地动作失败；创建需继续回滚，删除则保留 error。 */
    async failClientOperation(jobId, type, errorCode, errorMessage) {
        const job = await this.prisma.job.findUnique({ where: { id: jobId } });
        if (!job || job.type !== type) {
            throw new Error(`FRP Job "${jobId}" 不存在或类型不匹配`);
        }
        let payload;
        try {
            payload = JSON.parse(job.payload);
        }
        catch {
            throw new Error(`FRP Job "${jobId}" payload 无效`);
        }
        const mapping = await this.prisma.frpMapping.findUnique({
            where: { id: payload.mappingId },
            select: {
                id: true,
                clientId: true,
                name: true,
                operationTimeoutSeconds: true,
            },
        });
        if (!mapping) {
            return {
                terminal: true,
                result: { mappingId: payload.mappingId },
                errorCode: errorCode,
                errorMessage,
            };
        }
        if (type === "frp.create") {
            const rollbackJobId = (0, node_crypto_1.randomUUID)();
            const rollbackPayload = {
                mappingId: mapping.id,
                name: mapping.name,
                rollbackOfJobId: jobId,
            };
            await this.prisma.job.create({
                data: {
                    id: rollbackJobId,
                    clientId: mapping.clientId,
                    type: "frp.delete",
                    status: "running",
                    startedAt: new Date(),
                    payload: JSON.stringify(rollbackPayload),
                    timeout: mapping.operationTimeoutSeconds,
                },
            });
            await this.prisma.frpMapping.update({
                where: { id: mapping.id },
                data: {
                    status: "deleting",
                    operationJobId: rollbackJobId,
                    errorCode,
                    errorMessage,
                },
            });
            return {
                terminal: false,
                dispatch: {
                    jobId: rollbackJobId,
                    clientId: mapping.clientId,
                    type: "frp.delete",
                    payload: { ...rollbackPayload },
                    timeout: mapping.operationTimeoutSeconds,
                },
            };
        }
        const rollback = Boolean(payload.rollbackOfJobId);
        const finalCode = rollback
            ? "FRP_ROLLBACK_FAILED"
            : errorCode;
        await this.prisma.frpMapping.update({
            where: { id: mapping.id },
            data: {
                status: "error",
                operationJobId: null,
                errorCode: finalCode,
                errorMessage,
            },
        });
        return {
            terminal: true,
            result: { mappingId: mapping.id },
            errorCode: finalCode,
            errorMessage,
            ...(payload.rollbackOfJobId
                ? {
                    relatedJob: {
                        jobId: payload.rollbackOfJobId,
                        errorCode: finalCode,
                        errorMessage,
                    },
                }
                : {}),
        };
    }
    async getMapping(id) {
        const mapping = await this.prisma.frpMapping.findUnique({ where: { id } });
        return mapping ? this.toApi(mapping) : null;
    }
    async listMappings(clientId, page = 1, pageSize = 20) {
        const where = clientId ? { clientId } : {};
        const [list, total] = await Promise.all([
            this.prisma.frpMapping.findMany({
                where,
                orderBy: { createdAt: "desc" },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.prisma.frpMapping.count({ where }),
        ]);
        return {
            data: list.map((mapping) => this.toApi(mapping)),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
    async updateStatus(mappingId, status) {
        await this.prisma.frpMapping.update({
            where: { id: mappingId },
            data: { status },
        });
    }
    async markInactiveByClientId(clientId) {
        await this.prisma.frpMapping.updateMany({
            where: { clientId, status: "active" },
            data: { status: "inactive" },
        });
    }
    async waitForProxy(instance, proxyType, name, shouldExist, timeoutSeconds) {
        const deadline = Date.now() + timeoutSeconds * 1000;
        while (Date.now() <= deadline) {
            const proxies = await this.instancesService.listDashboardProxies(instance);
            // 二次确认只认 online：offline 残留条目（frpc 已断开）视为不存在。
            const online = proxies.list.some((proxy) => proxy.proxyType === proxyType &&
                proxy.name === name &&
                proxy.status === "online");
            if (online === shouldExist)
                return true;
            if (Date.now() >= deadline)
                break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return false;
    }
    async resolveName(frpsInstanceId, explicitName, baseName, mappingId, dashboardNames) {
        const exists = async (name) => dashboardNames.includes(name) ||
            Boolean(await this.prisma.frpMapping.findFirst({
                where: { frpsInstanceId, name },
                select: { id: true },
            }));
        if (explicitName) {
            if (await exists(explicitName)) {
                throw new FrpOperationError("FRP_PROXY_NAME_CONFLICT", `FRP proxy 名称 "${explicitName}" 已存在`);
            }
            return explicitName;
        }
        if (!(await exists(baseName)))
            return baseName;
        let candidate = `${baseName}-${mappingId.slice(-6)}`;
        for (let attempt = 0; attempt < 10; attempt++) {
            if (!(await exists(candidate)))
                return candidate;
            candidate = `${baseName}-${(0, node_crypto_1.randomUUID)().slice(0, 6)}`;
        }
        throw new FrpOperationError("FRP_PROXY_NAME_CONFLICT", "无法生成唯一 FRP proxy 名称");
    }
    toApi(mapping) {
        const view = {
            id: mapping.id,
            clientId: mapping.clientId,
            frpsInstanceId: mapping.frpsInstanceId,
            name: mapping.name,
            proxyType: mapping.proxyType,
            localIp: mapping.localIp,
            localPort: mapping.localPort,
            remotePort: mapping.remotePort,
            customDomain: mapping.customDomain,
            status: mapping.status,
            publicUrl: mapping.publicUrl,
            operationJobId: mapping.operationJobId ?? null,
            errorCode: (mapping.errorCode ?? null),
            errorMessage: mapping.errorMessage ?? null,
            createdAt: typeof mapping.createdAt === "string"
                ? mapping.createdAt
                : mapping.createdAt.toISOString(),
            updatedAt: typeof mapping.updatedAt === "string"
                ? mapping.updatedAt
                : mapping.updatedAt.toISOString(),
        };
        return view;
    }
};
exports.FrpService = FrpService;
exports.FrpService = FrpService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(frp_instances_service_js_1.FrpsInstancesService)),
    __param(2, (0, common_1.Optional)()),
    __param(2, (0, common_1.Inject)(frp_reconciliation_service_js_1.FrpReconciliationService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, frp_instances_service_js_1.FrpsInstancesService, frp_reconciliation_service_js_1.FrpReconciliationService])
], FrpService);
