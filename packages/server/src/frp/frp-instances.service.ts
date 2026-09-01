/** @file FRP 实例配置服务 — CRUD + 自动迁移 + 健康检查 */

import { Injectable, Inject, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { PrismaService } from "../prisma/prisma.service.js";
import type {
	FrpsInstanceCreateRequest,
	FrpsInstanceUpdateRequest,
	FrpsInstanceInfo,
	PaginatedResult,
	ProbeResult,
} from "@vcpdeck/shared";

/** FRPS Dashboard 写操作确认失败。 */
export class FrpsDashboardError extends Error {
	constructor(
		public readonly code:
			| "FRPS_DASHBOARD_REQUIRED"
			| "FRPS_DASHBOARD_UNREACHABLE"
			| "FRPS_DASHBOARD_AUTH_FAILED",
		message: string,
	) {
		super(message);
		this.name = "FrpsDashboardError";
	}
}

@Injectable()
export class FrpsInstancesService {
	private readonly logger = new Logger(FrpsInstancesService.name);

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	async create(dto: FrpsInstanceCreateRequest): Promise<FrpsInstanceInfo> {
		if (dto.isDefault) {
			await this.prisma.frpsInstance.updateMany({
				where: { isDefault: true },
				data: { isDefault: false },
			});
		}

		const id = `frps_${randomUUID().slice(0, 8)}`;
		const row = await this.prisma.frpsInstance.create({
			data: {
				id,
				name: dto.name,
				serverAddr: dto.serverAddr,
				serverPort: dto.serverPort ?? 7000,
				authToken: dto.authToken ?? "",
				dashboardScheme: dto.dashboardScheme ?? "http",
				dashboardHost: dto.dashboardHost ?? null,
				dashboardPort: dto.dashboardPort ?? 7500,
				dashboardUser: dto.dashboardUser ?? "admin",
				dashboardPassword: dto.dashboardPassword ?? "admin",
				portRangeStart: dto.portRangeStart ?? 20000,
				portRangeEnd: dto.portRangeEnd ?? 21000,
				isDefault: dto.isDefault ?? false,
			},
		});

		return this.toApi(row);
	}

	async getById(id: string): Promise<FrpsInstanceInfo | null> {
		const row = await this.prisma.frpsInstance.findUnique({ where: { id } });
		return row ? this.toApi(row) : null;
	}

	async list(
		page: number = 1,
		pageSize: number = 20,
	): Promise<PaginatedResult<FrpsInstanceInfo>> {
		const [list, total] = await Promise.all([
			this.prisma.frpsInstance.findMany({
				orderBy: { createdAt: "asc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.prisma.frpsInstance.count(),
		]);
		return {
			data: list.map((r) => this.toApi(r)),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	async update(
		id: string,
		dto: FrpsInstanceUpdateRequest,
	): Promise<FrpsInstanceInfo> {
		const existing = await this.prisma.frpsInstance.findUnique({
			where: { id },
		});
		if (!existing) throw new Error(`FrpsInstance "${id}" 不存在`);

		if (dto.isDefault === true) {
			await this.prisma.frpsInstance.updateMany({
				where: { isDefault: true, id: { not: id } },
				data: { isDefault: false },
			});
		}

		const data: Record<string, unknown> = {};
		if (dto.name !== undefined) data.name = dto.name;
		if (dto.serverAddr !== undefined) data.serverAddr = dto.serverAddr;
		if (dto.serverPort !== undefined) data.serverPort = dto.serverPort;
		if (dto.authToken !== undefined) data.authToken = dto.authToken;
		if (dto.dashboardScheme !== undefined)
			data.dashboardScheme = dto.dashboardScheme;
		if (dto.dashboardHost !== undefined) data.dashboardHost = dto.dashboardHost;
		if (dto.dashboardPort !== undefined) data.dashboardPort = dto.dashboardPort;
		if (dto.dashboardUser !== undefined) data.dashboardUser = dto.dashboardUser;
		if (dto.dashboardPassword !== undefined)
			data.dashboardPassword = dto.dashboardPassword;
		if (dto.portRangeStart !== undefined)
			data.portRangeStart = dto.portRangeStart;
		if (dto.portRangeEnd !== undefined) data.portRangeEnd = dto.portRangeEnd;
		if (dto.isDefault !== undefined) data.isDefault = dto.isDefault;

		const row = await this.prisma.frpsInstance.update({
			where: { id },
			data,
		});
		return this.toApi(row);
	}

	async delete(id: string): Promise<boolean> {
		const existing = await this.prisma.frpsInstance.findUnique({
			where: { id },
		});
		if (!existing) return false;

		const mappingCount = await this.prisma.frpMapping.count({
			where: { frpsInstanceId: id },
		});
		if (mappingCount > 0) {
			throw new Error(
				`无法删除：${mappingCount} 个映射关联到实例 "${existing.name}"`,
			);
		}

		await this.prisma.frpsInstance.delete({ where: { id } });
		return true;
	}

	/** 获取默认实例 */
	async getDefault(): Promise<FrpsInstanceInfo> {
		const row = await this.prisma.frpsInstance.findFirst({
			where: { isDefault: true },
		});
		if (!row) throw new Error("没有默认 FRP 实例，请先配置");
		return this.toApi(row);
	}

	/** 设置默认实例 */
	async setDefault(id: string): Promise<FrpsInstanceInfo> {
		await this.prisma.frpsInstance.updateMany({
			where: { isDefault: true },
			data: { isDefault: false },
		});
		const row = await this.prisma.frpsInstance.update({
			where: { id },
			data: { isDefault: true },
		});
		return this.toApi(row);
	}

	/** 首次启动：如 DB 无任何实例，从环境变量自动迁移 */
	async migrateFromEnvIfNeeded(): Promise<FrpsInstanceInfo | null> {
		const count = await this.prisma.frpsInstance.count();
		if (count > 0) return null;

		const row = await this.prisma.frpsInstance.create({
			data: {
				id: `frps_${randomUUID().slice(0, 8)}`,
				name: "默认（从环境变量迁移）",
				serverAddr: process.env.FRP_PUBLIC_HOST || "127.0.0.1",
				serverPort: parseInt(process.env.FRPS_BIND_PORT || "17000", 10),
				authToken: process.env.FRPS_TOKEN || "test-frp-token",
				dashboardScheme:
					(process.env.FRP_DASHBOARD_SCHEME as "http" | "https") || "http",
				dashboardHost: process.env.FRP_DASHBOARD_HOST || "127.0.0.1",
				dashboardPort: parseInt(
					process.env.FRP_DASHBOARD_PORT || "17500",
					10,
				),
				dashboardUser: process.env.FRP_DASHBOARD_USER || "admin",
				dashboardPassword: process.env.FRP_DASHBOARD_PASSWORD || "admin",
				portRangeStart: parseInt(
					process.env.FRP_PORT_RANGE_START || "20000",
					10,
				),
				portRangeEnd: parseInt(
					process.env.FRP_PORT_RANGE_END || "21000",
					10,
				),
				isDefault: true,
			},
		});

		this.logger.log("已从环境变量迁移 FRP 配置到 DB");
		return this.toApi(row);
	}

	/** 健康检查 */
	async probe(id: string): Promise<ProbeResult> {
		const instance = await this.getById(id);
		if (!instance) throw new Error(`FrpsInstance "${id}" 不存在`);

		// 1. TCP 连接检查
		const tcpResult = await this.probeTcp(
			instance.serverAddr,
			instance.serverPort,
		);

		// 2. Dashboard 检查
		if (instance.dashboardHost) {
			const dashResult = await this.probeDashboard(instance);

			// 3. 拉取已注册 proxy 列表
			let proxies: ProbeResult["proxies"] = null;
			if (dashResult.authValid) {
				proxies = await this.fetchProxyList(instance);
			}

			return {
				ok: dashResult.authValid,
				tcpReachable: tcpResult.ok,
				tcpLatencyMs: tcpResult.latencyMs,
				dashboardReachable: dashResult.reachable,
				authValid: dashResult.authValid,
				serverInfo: dashResult.serverInfo,
				error: dashResult.error,
				proxies,
			};
		}

		// 无 Dashboard：仅 TCP 检查
		return {
			ok: tcpResult.ok,
			tcpReachable: tcpResult.ok,
			tcpLatencyMs: tcpResult.latencyMs,
			dashboardReachable: false,
			authValid: false,
			error: tcpResult.ok
				? undefined
				: "TCP 连接失败且未配置 Dashboard",
			proxies: null,
		};
	}

	/** TCP 连接检查 */
	private probeTcp(
		host: string,
		port: number,
		timeoutMs = 5000,
	): Promise<{ ok: boolean; latencyMs: number }> {
		const startedAt = Date.now();
		return new Promise((resolve) => {
			const socket = net.createConnection({ host, port });
			const finish = (ok: boolean) => {
				socket.removeAllListeners();
				socket.destroy();
				resolve({ ok, latencyMs: Date.now() - startedAt });
			};
			socket.setTimeout(timeoutMs);
			socket.once("connect", () => finish(true));
			socket.once("timeout", () => finish(false));
			socket.once("error", () => finish(false));
		});
	}

	/** Dashboard 认证检查 */
	private async probeDashboard(instance: FrpsInstanceInfo): Promise<{
		reachable: boolean;
		authValid: boolean;
		serverInfo?: { version: string };
		error?: string;
	}> {
		try {
			const auth = Buffer.from(
				`${instance.dashboardUser}:${instance.dashboardPassword}`,
			).toString("base64");

			const res = await fetch(
				`${instance.dashboardScheme}://${instance.dashboardHost}:${instance.dashboardPort}/api/serverinfo`,
				{
					headers: { Authorization: `Basic ${auth}` },
					signal: AbortSignal.timeout(5000),
				},
			);

			if (res.status === 200) {
				const body = (await res.json()) as { version?: string };
				return {
					reachable: true,
					authValid: true,
					serverInfo: { version: body.version ?? "unknown" },
				};
			}

			if (res.status === 401 || res.status === 403) {
				return {
					reachable: true,
					authValid: false,
					error: `认证失败: HTTP ${res.status}`,
				};
			}

			return {
				reachable: true,
				authValid: false,
				error: `Dashboard 返回异常状态: ${res.status}`,
			};
		} catch (err) {
			return {
				reachable: false,
				authValid: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/** 严格拉取 FRPS 已注册 proxy；写操作不得把 Dashboard 失败当空列表。 */
	async listDashboardProxies(
		instance: FrpsInstanceInfo,
	): Promise<NonNullable<ProbeResult["proxies"]>> {
		if (!instance.dashboardHost) {
			throw new FrpsDashboardError(
				"FRPS_DASHBOARD_REQUIRED",
				"FRPS 实例必须配置 Dashboard",
			);
		}
		const auth = Buffer.from(
			`${instance.dashboardUser}:${instance.dashboardPassword}`,
		).toString("base64");
		const base = `${instance.dashboardScheme}://${instance.dashboardHost}:${instance.dashboardPort}`;
		const types = ["tcp", "http", "https"] as const;
		try {
			const results = await Promise.all(
				types.map(async (proxyType) => {
					const response = await fetch(`${base}/api/proxy/${proxyType}`, {
						headers: { Authorization: `Basic ${auth}` },
						signal: AbortSignal.timeout(5000),
					});
					if (response.status === 401 || response.status === 403) {
						throw new FrpsDashboardError(
							"FRPS_DASHBOARD_AUTH_FAILED",
							"FRPS Dashboard 认证失败",
						);
					}
					if (!response.ok) {
						throw new FrpsDashboardError(
							"FRPS_DASHBOARD_UNREACHABLE",
							"FRPS Dashboard 不可达",
						);
					}
					const body = (await response.json()) as {
						proxies?: Array<{
							name?: string;
							remotePort?: number;
							status?: string;
							conf?: { remotePort?: number };
						}>;
					};
					return (body.proxies ?? [])
						.filter((proxy) => typeof proxy.name === "string")
						.map((proxy) => ({
							name: proxy.name!,
							proxyType,
							// frps 会把已断开 frpc 的 proxy 以 offline 残留于列表；只有 online 才算真实在线。
							status: (proxy.status === "online" ? "online" : "offline") as "online" | "offline",
							remotePort:
								proxy.remotePort ?? proxy.conf?.remotePort ?? null,
						}));
				}),
			);
			const list = results.flat();
			return {
				total: list.length,
				byType: {
					tcp: list.filter((proxy) => proxy.proxyType === "tcp").length,
					http: list.filter((proxy) => proxy.proxyType === "http").length,
					https: list.filter((proxy) => proxy.proxyType === "https").length,
				},
				list,
				// 仅统计在线 proxy 占用的端口（offline 残留条目的端口已被 FRPS 释放）。
				usedPorts: [
					...new Set(
						list
							.filter((proxy) => proxy.status === "online")
							.map((proxy) => proxy.remotePort)
							.filter((port): port is number => port !== null)
							.sort((a, b) => a - b),
					),
				],
			};
		} catch (error) {
			if (error instanceof FrpsDashboardError) throw error;
			throw new FrpsDashboardError(
				"FRPS_DASHBOARD_UNREACHABLE",
				"FRPS Dashboard 不可达",
			);
		}
	}

	/** 健康摘要沿用宽松语义；写操作使用 listDashboardProxies。 */
	private async fetchProxyList(
		instance: FrpsInstanceInfo,
	): Promise<ProbeResult["proxies"]> {
		try {
			return await this.listDashboardProxies(instance);
		} catch {
			return null;
		}
	}

	private toApi(row: any): FrpsInstanceInfo {
		return {
			id: row.id,
			name: row.name,
			serverAddr: row.serverAddr,
			serverPort: row.serverPort,
			authToken: row.authToken,
			dashboardScheme: row.dashboardScheme,
			dashboardHost: row.dashboardHost,
			dashboardPort: row.dashboardPort,
			dashboardUser: row.dashboardUser,
			dashboardPassword: row.dashboardPassword,
			portRangeStart: row.portRangeStart,
			portRangeEnd: row.portRangeEnd,
			isDefault: row.isDefault,
			createdAt:
				typeof row.createdAt === "string"
					? row.createdAt
					: row.createdAt.toISOString(),
			updatedAt:
				typeof row.updatedAt === "string"
					? row.updatedAt
					: row.updatedAt.toISOString(),
		};
	}
}
