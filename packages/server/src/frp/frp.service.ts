/** @file FRP 映射服务 — 持久化、端口分配与 Dashboard 收敛 */

import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
	DispatchPayload,
	FrpDeletePayload,
	FrpErrorCode,
	FrpMappingCreateRequest,
	FrpMappingInfo,
	FrpMappingStatus,
	PaginatedResult,
} from "@vcpdeck/shared";

type FrpMappingCreateInput = FrpMappingCreateRequest;
type FrpMappingView = FrpMappingInfo;

type FrpSettlement =
	| {
			terminal: false;
			dispatch: DispatchPayload;
	  }
	| {
			terminal: true;
			result: Record<string, unknown>;
			errorCode?: FrpErrorCode;
			errorMessage?: string;
			relatedJob?: {
				jobId: string;
				errorCode: FrpErrorCode;
				errorMessage: string;
			};
	  };
import { PrismaService } from "../prisma/prisma.service.js";
import { FrpsInstancesService } from "./frp-instances.service.js";
import { PortAllocator } from "./port-allocator.js";

/** FRP 映射操作稳定失败。 */
class FrpOperationError extends Error {
	constructor(
		public readonly code: FrpErrorCode,
		message: string,
	) {
		super(message);
		this.name = "FrpOperationError";
	}
}

function buildPublicUrl(
	remotePort: number | null,
	proxyType: "tcp" | "http" | "https",
	customDomain: string | null,
	serverAddr: string,
): string | null {
	if (proxyType === "tcp") {
		return remotePort === null ? null : `${serverAddr}:${remotePort}`;
	}
	return customDomain ? `${proxyType}://${customDomain}` : null;
}

@Injectable()
export class FrpService {
	private readonly allocator: PortAllocator;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(FrpsInstancesService)
		private readonly instancesService: FrpsInstancesService,
	) {
		this.allocator = new PortAllocator(prisma);
	}

	async createMapping(
		dto: FrpMappingCreateInput,
	): Promise<{ mapping: FrpMappingView; dispatch: DispatchPayload }> {
		const client = await this.prisma.client.findUnique({
			where: { id: dto.clientId },
		});
		if (!client) throw new Error(`Client "${dto.clientId}" 不存在`);
		if (!client.online) throw new Error(`Client "${dto.clientId}" 不在线`);
		let capabilities: string[] = [];
		try {
			capabilities = JSON.parse(client.capabilities) as string[];
		} catch {
			capabilities = [];
		}
		if (!capabilities.includes("frp")) {
			throw new Error(`Client "${dto.clientId}" 未启用 FRP 能力`);
		}

		const instance = dto.frpsInstanceId
			? await this.instancesService.getById(dto.frpsInstanceId)
			: await this.instancesService.getDefault();
		if (!instance) throw new Error("未找到目标 FRP 实例");

		const clientMapping = await this.prisma.frpMapping.findFirst({
			where: { clientId: dto.clientId },
			select: { frpsInstanceId: true },
		});
		if (
			clientMapping?.frpsInstanceId &&
			clientMapping.frpsInstanceId !== instance.id
		) {
			throw new Error("同一 Client 当前只能使用一个 FRPS 实例");
		}

		const dashboard = await this.instancesService.listDashboardProxies(instance);
		const id = `fm_${randomUUID().slice(0, 8)}`;
		const name = await this.resolveName(
			instance.id,
			dto.name,
			`${dto.proxyType}-${dto.localPort}`,
			id,
			dashboard.list.map((proxy) => proxy.name),
		);
		const remotePort =
			dto.proxyType === "tcp"
				? await this.allocator.allocate({
						preferredPort: dto.remotePort,
						portRangeStart: instance.portRangeStart,
						portRangeEnd: instance.portRangeEnd,
						usedPorts: dashboard.usedPorts,
					})
				: null;
		const jobId = randomUUID();
		const timeoutSeconds = dto.timeoutSeconds ?? 30;
		const publicUrl = buildPublicUrl(
			remotePort,
			dto.proxyType,
			dto.customDomain ?? null,
			instance.serverAddr,
		);
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
				payload: payload as unknown as Record<string, unknown>,
				timeout: timeoutSeconds,
			},
		};
	}

	async deleteMapping(
		id: string,
		timeoutSeconds = 30,
	): Promise<{ mapping: FrpMappingInfo; dispatch: DispatchPayload } | null> {
		const mapping = await this.prisma.frpMapping.findUnique({ where: { id } });
		if (!mapping) return null;
		const client = await this.prisma.client.findUnique({
			where: { id: mapping.clientId },
			select: { online: true },
		});
		if (!client?.online) {
			throw new Error(`Client "${mapping.clientId}" 不在线`);
		}
		const payload: FrpDeletePayload = { mappingId: id, name: mapping.name };
		const jobId = randomUUID();
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
				payload: payload as unknown as Record<string, unknown>,
				timeout: timeoutSeconds,
			},
		};
	}

	/** Client 本地 FRP 动作完成后，以 Dashboard 状态收敛操作。 */
	async settleClientOperation(
		jobId: string,
		type: "frp.create" | "frp.delete",
	): Promise<FrpSettlement> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job || job.type !== type) {
			throw new Error(`FRP Job "${jobId}" 不存在或类型不匹配`);
		}
		let payload: {
			mappingId: string;
			name: string;
			rollbackOfJobId?: string;
		};
		try {
			payload = JSON.parse(job.payload) as typeof payload;
		} catch {
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
			throw new FrpOperationError(
				"FRPS_DASHBOARD_REQUIRED",
				"映射未关联 FRPS 实例",
			);
		}
		const instance = await this.instancesService.getById(mapping.frpsInstanceId);
		if (!instance) throw new Error("映射关联的 FRPS 实例不存在");
		const shouldExist = type === "frp.create";
		let confirmed = false;
		let dashboardError:
			| { code: FrpErrorCode; message: string }
			| undefined;
		try {
			confirmed = await this.waitForProxy(
				instance,
				mapping.proxyType,
				mapping.name,
				shouldExist,
				mapping.operationTimeoutSeconds,
			);
		} catch (error) {
			const failure = error as { code?: FrpErrorCode; message?: string };
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
			if (!payload.rollbackOfJobId) return { terminal: true, result };
			return {
				terminal: true,
				result,
				relatedJob: {
					jobId: payload.rollbackOfJobId,
					errorCode:
						(mapping.errorCode as FrpErrorCode | null) ??
						"FRP_PROXY_CONFIRM_TIMEOUT",
					errorMessage:
						mapping.errorMessage ??
						"FRPS 未在时限内确认 proxy 注册；已自动回滚",
				},
			};
		}

		if (shouldExist) {
			const rollbackJobId = randomUUID();
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
					errorCode:
						dashboardError?.code ?? "FRP_PROXY_CONFIRM_TIMEOUT",
					errorMessage:
						dashboardError?.message ??
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
		const errorCode: FrpErrorCode = rollback
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
	async failClientOperation(
		jobId: string,
		type: "frp.create" | "frp.delete",
		errorCode: string,
		errorMessage: string,
	): Promise<FrpSettlement> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job || job.type !== type) {
			throw new Error(`FRP Job "${jobId}" 不存在或类型不匹配`);
		}
		let payload: { mappingId: string; name: string; rollbackOfJobId?: string };
		try {
			payload = JSON.parse(job.payload) as typeof payload;
		} catch {
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
				errorCode: errorCode as FrpErrorCode,
				errorMessage,
			};
		}
		if (type === "frp.create") {
			const rollbackJobId = randomUUID();
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
		const finalCode: FrpErrorCode = rollback
			? "FRP_ROLLBACK_FAILED"
			: (errorCode as FrpErrorCode);
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

	async getMapping(id: string): Promise<FrpMappingInfo | null> {
		const mapping = await this.prisma.frpMapping.findUnique({ where: { id } });
		return mapping ? this.toApi(mapping) : null;
	}

	async listMappings(
		clientId?: string,
		page = 1,
		pageSize = 20,
	): Promise<PaginatedResult<FrpMappingInfo>> {
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

	async updateStatus(mappingId: string, status: FrpMappingStatus): Promise<void> {
		await this.prisma.frpMapping.update({
			where: { id: mappingId },
			data: { status },
		});
	}

	async markInactiveByClientId(clientId: string): Promise<void> {
		await this.prisma.frpMapping.updateMany({
			where: { clientId, status: "active" },
			data: { status: "inactive" },
		});
	}

	private async waitForProxy(
		instance: Parameters<FrpsInstancesService["listDashboardProxies"]>[0],
		proxyType: string,
		name: string,
		shouldExist: boolean,
		timeoutSeconds: number,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutSeconds * 1000;
		while (Date.now() <= deadline) {
			const proxies = await this.instancesService.listDashboardProxies(instance);
			const exists = proxies.list.some(
				(proxy) => proxy.proxyType === proxyType && proxy.name === name,
			);
			if (exists === shouldExist) return true;
			if (Date.now() >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return false;
	}

	private async resolveName(
		frpsInstanceId: string,
		explicitName: string | undefined,
		baseName: string,
		mappingId: string,
		dashboardNames: string[],
	): Promise<string> {
		const exists = async (name: string) =>
			dashboardNames.includes(name) ||
			Boolean(
				await this.prisma.frpMapping.findFirst({
					where: { frpsInstanceId, name },
					select: { id: true },
				}),
			);
		if (explicitName) {
			if (await exists(explicitName)) {
				throw new FrpOperationError(
					"FRP_PROXY_NAME_CONFLICT",
					`FRP proxy 名称 "${explicitName}" 已存在`,
				);
			}
			return explicitName;
		}
		if (!(await exists(baseName))) return baseName;
		let candidate = `${baseName}-${mappingId.slice(-6)}`;
		for (let attempt = 0; attempt < 10; attempt++) {
			if (!(await exists(candidate))) return candidate;
			candidate = `${baseName}-${randomUUID().slice(0, 6)}`;
		}
		throw new FrpOperationError(
			"FRP_PROXY_NAME_CONFLICT",
			"无法生成唯一 FRP proxy 名称",
		);
	}

	private toApi(mapping: {
		id: string;
		clientId: string;
		frpsInstanceId: string | null;
		name: string;
		proxyType: string;
		localIp: string;
		localPort: number;
		remotePort: number | null;
		customDomain: string | null;
		status: string;
		publicUrl: string | null;
		operationJobId?: string | null;
		errorCode?: string | null;
		errorMessage?: string | null;
		createdAt: Date | string;
		updatedAt: Date | string;
	}): FrpMappingView {
		const view = {
			id: mapping.id,
			clientId: mapping.clientId,
			frpsInstanceId: mapping.frpsInstanceId,
			name: mapping.name,
			proxyType: mapping.proxyType as FrpMappingInfo["proxyType"],
			localIp: mapping.localIp,
			localPort: mapping.localPort,
			remotePort: mapping.remotePort,
			customDomain: mapping.customDomain,
			status: mapping.status as FrpMappingStatus,
			publicUrl: mapping.publicUrl,
			operationJobId: mapping.operationJobId ?? null,
			errorCode: (mapping.errorCode ?? null) as FrpErrorCode | null,
			errorMessage: mapping.errorMessage ?? null,
			createdAt:
				typeof mapping.createdAt === "string"
					? mapping.createdAt
					: mapping.createdAt.toISOString(),
			updatedAt:
				typeof mapping.updatedAt === "string"
					? mapping.updatedAt
					: mapping.updatedAt.toISOString(),
		};
		return view;
	}
}
