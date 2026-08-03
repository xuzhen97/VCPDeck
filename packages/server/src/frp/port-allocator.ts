/** @file 端口分配器 — DB 检查 + 可选 frps Dashboard 对账 */

import type { PrismaService } from "../prisma/prisma.service.js";

/** Dashboard 配置（由调用者传入，不再从环境变量读取） */
export interface DashboardConfig {
	scheme: "http" | "https";
	host: string;
	port: number;
	user: string;
	password: string;
}

export interface AllocateOptions {
	preferredPort?: number;
	portRangeStart?: number;
	portRangeEnd?: number;
	dashboard?: DashboardConfig | null;
}

export class PortAllocator {
	private allocationQueue: Promise<unknown> = Promise.resolve();

	constructor(private readonly prisma: PrismaService) {}

	/**
	 * 分配一个可用端口
	 * 1. 查 DB 已用端口
	 * 2. 如配置了 Dashboard → 查 Dashboard 已用端口（可选，不可达时降级）
	 * 3. 从范围中取第一个空闲端口
	 */
	async allocate(options?: AllocateOptions): Promise<number> {
		const portRangeStart = options?.portRangeStart ?? 20000;
		const portRangeEnd = options?.portRangeEnd ?? 21000;
		const dashboard = options?.dashboard ?? null;

		return this.withLock(async () => {
			const usedPorts = await this.loadUsedPorts(dashboard);

			if (typeof options?.preferredPort === "number") {
				const p = options.preferredPort;
				if (p < portRangeStart || p > portRangeEnd) {
					throw new Error(
						`端口 ${p} 超出配置范围 ${portRangeStart}-${portRangeEnd}`,
					);
				}
				if (usedPorts.has(p)) {
					throw new Error(`端口 ${p} 已被占用`);
				}
				return p;
			}

			for (let port = portRangeStart; port <= portRangeEnd; port++) {
				if (!usedPorts.has(port)) return port;
			}

			throw new Error(
				`端口范围 ${portRangeStart}-${portRangeEnd} 内无可用端口`,
			);
		});
	}

	/** 释放端口（当前为 no-op，DB 删除即为释放） */
	release(_port: number): void {
		// ponytail: DB 记录已删除，端口自然释放。后续加审计日志时在此实现。
	}

	private async loadUsedPorts(
		dashboard: DashboardConfig | null,
	): Promise<Set<number>> {
		const mappings = await this.prisma.frpMapping.findMany({
			where: { remotePort: { not: null } },
			select: { remotePort: true },
		});
		const used = new Set(
			mappings.map((m) => m.remotePort!).filter((p) => p !== null),
		);

		// Dashboard 对账（如配置了）
		if (dashboard) {
			try {
				const auth = Buffer.from(
					`${dashboard.user}:${dashboard.password}`,
				).toString("base64");
				const types = ["tcp", "http", "https"] as const;
				for (const t of types) {
					const res = await fetch(
						`${dashboard.scheme}://${dashboard.host}:${dashboard.port}/api/proxy/${t}`,
						{
							headers: { Authorization: `Basic ${auth}` },
							signal: AbortSignal.timeout(5000),
						},
					);
					if (!res.ok) continue;
					const body = (await res.json()) as {
						proxies?: Array<{
							remotePort?: number;
							conf?: { remotePort?: number };
						}>;
					};
					for (const p of body.proxies ?? []) {
						const rp = p.remotePort ?? p.conf?.remotePort;
						if (typeof rp === "number") used.add(rp);
					}
				}
			} catch {
				// Dashboard 不可达 → 降级警告，不阻塞分配
				console.warn(
					"[port-allocator] frps Dashboard 不可达，降级为仅 DB 检查",
				);
			}
		}

		return used;
	}

	/** 串行化锁，防并发分配同一端口 */
	private async withLock<T>(work: () => Promise<T>): Promise<T> {
		const next = this.allocationQueue.then(work, work);
		this.allocationQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
