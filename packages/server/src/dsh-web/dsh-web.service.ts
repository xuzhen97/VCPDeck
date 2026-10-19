import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
	DispatchPayload,
	DshWebCommand,
	DshWebCommandResult,
	DshWebMode,
	DshWebState,
} from "@vcpdeck/shared";
import { randomUUID } from "node:crypto";
import { FrpService } from "../frp/frp.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

export type DshWebErrorCode =
	| "DSH_WEB_CLIENT_OFFLINE"
	| "DSH_WEB_UNSUPPORTED"
	| "DSH_WEB_ALREADY_RUNNING"
	| "DSH_WEB_NOT_RUNNING"
	| "DSH_WEB_COMMAND_FAILED"
	| "DSH_WEB_STOP_INCOMPLETE"
	| "DSH_WEB_EXTERNAL_MANAGED"
	| "DSH_WEB_FRP_UNAVAILABLE";

export class DshWebError extends Error {
	constructor(
		readonly code: DshWebErrorCode,
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "DshWebError";
	}
}

function fail(
	code: DshWebErrorCode,
	message: string,
	statusCode: number,
): DshWebError {
	return new DshWebError(code, message, statusCode);
}

/** 对外暴露的通道状态。 */
export interface DshWebStatus {
	clientId: string;
	state: DshWebState;
	port: number | null;
	url: string | null;
	/** 归属模式；`external` 表示实例由目标机自己管，VCPDeck 不起停它。 */
	mode: DshWebMode;
}

export interface DshWebServiceDeps {
	prisma: PrismaService;
	frp: Pick<FrpService, "createMapping" | "deleteMapping">;
	/** socketId → `/client` 命名空间发送通道；由 gateway 绑定。 */
	send?: (socketId: string, command: DshWebCommand) => void;
	/**
	 * FRP 映射下发通道。
	 *
	 * `createMapping`/`deleteMapping` 只改 DB 与返回 dispatch，真正让 frpc 生效
	 * 必须再把 dispatch 发给 Client；漏了这一步的表现是"映射存在但端口不通"。
	 */
	dispatch?: (payload: DispatchPayload) => void;
	now?: () => Date;
	startTimeoutMs?: number;
}

const DEFAULT_PORT_BASE = 30_000;
const PORT_SPAN = 10_000;

/**
 * 远程 DSH 通道的受管生命周期（ADR-0059 修订）。
 *
 * 一次 `start` 做三件事：让目标机起 `dsh web`（loopback）→ 为它建一条 FRP TCP
 * 映射 → 把「公网地址 + 一次性 token」拼成 `dshWebUrl` 落库。`stop` 反过来收尾：
 * 停进程、删映射、清字段。任何一步失败都不留半开状态。
 */
@Injectable()
export class DshWebService {
	private deps: DshWebServiceDeps;
	private readonly pending = new Map<
		string,
		{
			resolve: (result: DshWebCommandResult) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(
		@Inject(PrismaService) prisma: PrismaService,
		@Optional() @Inject(FrpService) frp?: FrpService,
	) {
		if (!frp) {
			throw new Error("DshWebService 需要 FrpService");
		}
		this.deps = { prisma, frp };
	}

	static withDeps(deps: DshWebServiceDeps): DshWebService {
		const service = Object.create(DshWebService.prototype) as DshWebService;
		Object.assign(service, { deps, pending: new Map() });
		return service;
	}

	bindEmitter(send: (socketId: string, command: DshWebCommand) => void): void {
		this.deps.send = send;
	}

	/** 绑定 FRP 映射下发通道（由 gateway 提供）。 */
	bindDispatch(dispatch: (payload: DispatchPayload) => void): void {
		this.deps.dispatch = dispatch;
	}

	private get now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	async status(clientId: string): Promise<DshWebStatus> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: clientId },
		});
		if (!client) {
			throw fail("DSH_WEB_CLIENT_OFFLINE", `Client "${clientId}" 不存在`, 404);
		}
		const row = client as unknown as {
			dshWebState?: string;
			dshWebMode?: string | null;
			dshWebPort?: number | null;
			dshWebUrl?: string | null;
		};
		const state = (row.dshWebState as DshWebState | undefined) ?? "stopped";
		return {
			clientId,
			state,
			port: row.dshWebPort ?? null,
			url: row.dshWebUrl ?? null,
			mode:
				row.dshWebMode === "external" || state === "external"
					? "external"
					: "managed",
		};
	}

	async start(clientId: string): Promise<DshWebStatus> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: clientId },
		});
		if (!client) {
			throw fail("DSH_WEB_CLIENT_OFFLINE", `Client "${clientId}" 不存在`, 404);
		}
		const row = client as unknown as {
			online: boolean;
			socketId: string | null;
			capabilities: string;
			dshWebState?: string;
			dshWebMode?: string | null;
			dshWebUrl?: string | null;
		};
		// 外部托管（systemd 常驻 / 自有反代）：绝不代起第二个实例，更不能覆盖别人登记的入口。
		if (row.dshWebMode === "external" || row.dshWebState === "external") {
			throw fail(
				"DSH_WEB_EXTERNAL_MANAGED",
				"这台机器的 DSH 由外部托管（常驻服务或自有反代）：VCPDeck 只维护入口地址，不会起停它。想让 VCPDeck 代管，先停掉目标机的常驻实例并解除登记。",
				409,
			);
		}
		if (!row.online || !row.socketId) {
			throw fail("DSH_WEB_CLIENT_OFFLINE", "目标 Client 不在线", 409);
		}
		const capabilities = parseCapabilities(row.capabilities);
		if (!capabilities.includes("dsh-web")) {
			throw fail(
				"DSH_WEB_UNSUPPORTED",
				"目标 Client 未声明 dsh-web 能力（需要新版本 Client）",
				409,
			);
		}
		if (row.dshWebState === "starting") {
			throw fail("DSH_WEB_ALREADY_RUNNING", "通道正在启动中", 409);
		}
		if (row.dshWebState === "running") {
			return this.status(clientId);
		}

		const port = this.allocatePort();
		await this.updateClient(clientId, {
			dshWebState: "starting",
			dshWebPort: port,
			dshWebUrl: null,
			dshWebFrpMappingId: null,
		});

		let started: DshWebCommandResult;
		try {
			started = await this.command(row.socketId, {
				requestId: randomUUID(),
				action: "start",
				clientId,
				port,
			});
		} catch (cause) {
			await this.updateClient(clientId, { dshWebState: "failed" });
			throw cause;
		}
		if (!started.ok || !started.token) {
			await this.updateClient(clientId, { dshWebState: "failed" });
			throw fail(
				"DSH_WEB_COMMAND_FAILED",
				started.error?.message ?? "目标机启动 dsh web 失败",
				502,
			);
		}

		let mappingId: string;
		let publicUrl: string | null;
		try {
			const created = await this.deps.frp.createMapping({
				clientId,
				name: `dsh-web-${port}`,
				proxyType: "tcp",
				localIp: "127.0.0.1",
				localPort: port,
			});
			// 只落库不生效：必须把 dispatch 下发给 Client，frpc 才会真正建这条代理。
			this.deps.dispatch?.(created.dispatch);
			mappingId = created.mapping.id;
			publicUrl = created.mapping.publicUrl ?? null;
		} catch (cause) {
			// 映射失败就回滚进程，避免留下一个无人可访问的 dsh web。
			// 只发不收：回滚是尽力而为，不能让错误路径被超时拖住。
			this.sendOnly(row.socketId, {
				requestId: randomUUID(),
				action: "stop",
				clientId,
				port,
			});
			await this.updateClient(clientId, {
				dshWebState: "failed",
				dshWebPort: null,
			});
			throw fail(
				"DSH_WEB_FRP_UNAVAILABLE",
				cause instanceof Error ? cause.message : "创建 FRP 映射失败",
				502,
			);
		}

		if (!publicUrl) {
			await this.deps.frp
				.deleteMapping(mappingId)
				.then((removed) => {
					if (removed) this.deps.dispatch?.(removed.dispatch);
				})
				.catch(() => undefined);
			this.sendOnly(row.socketId, {
				requestId: randomUUID(),
				action: "stop",
				clientId,
				port,
			});
			await this.updateClient(clientId, {
				dshWebState: "failed",
				dshWebPort: null,
			});
			throw fail("DSH_WEB_FRP_UNAVAILABLE", "FRP 映射没有可用地址", 502);
		}

		const url = buildDshWebUrl(publicUrl, started.token);
		await this.updateClient(clientId, {
			dshWebState: "running",
			// 代管成功即归属 managed：清掉可能残留的 external 标记。
			dshWebMode: "managed",
			dshWebPort: started.port ?? port,
			dshWebUrl: url,
			dshWebFrpMappingId: mappingId,
		});
		return {
			clientId,
			state: "running",
			port: started.port ?? port,
			url,
			mode: "managed",
		};
	}

	async stop(clientId: string): Promise<DshWebStatus> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: clientId },
		});
		if (!client) {
			throw fail("DSH_WEB_CLIENT_OFFLINE", `Client "${clientId}" 不存在`, 404);
		}
		const row = client as unknown as {
			socketId: string | null;
			dshWebState?: string;
			dshWebMode?: string | null;
			dshWebPort?: number | null;
			dshWebFrpMappingId?: string | null;
		};
		// 外部托管的实例不归 VCPDeck 管：停止 = 解除登记，不向 Client 发任何命令。
		if (row.dshWebMode === "external" || row.dshWebState === "external") {
			return this.detach(clientId);
		}

		const running = row.dshWebState === "running" || row.dshWebState === "starting";
		let stopIncomplete = false;
		if (row.socketId && row.dshWebPort) {
			await this.command(row.socketId, {
				requestId: randomUUID(),
				action: "stop",
				clientId,
				port: row.dshWebPort,
			}).then(
				(result) => {
					// Client 明确说没杀干净（端口仍监听）时不要假装成功。
					if (!result.ok) stopIncomplete = true;
				},
				() => {
					// 非运行态下通道不可用不算失败：没有证据表明还有进程。
					if (running) stopIncomplete = true;
				},
			);
		}
		if (row.dshWebFrpMappingId) {
			await this.deleteMappingQuietly(row.dshWebFrpMappingId);
		}
		await this.updateClient(clientId, {
			// 进程没杀干净时标 failed 而不是 stopped：UI 要能看出来还得再点一次。
			dshWebState: stopIncomplete ? "failed" : "stopped",
			dshWebUrl: null,
			dshWebPort: stopIncomplete ? row.dshWebPort : null,
			dshWebFrpMappingId: null,
		});
		if (stopIncomplete) {
			throw fail("DSH_WEB_STOP_INCOMPLETE", "dsh web 进程未能退出，请重试停止", 502);
		}
		return {
			clientId,
			state: "stopped",
			port: null,
			url: null,
			mode: "managed",
		};
	}

	/**
	 * 解除外部托管的登记（ADR-0059 决策 12）。
	 *
	 * 只清 VCPDeck 侧的地址与归属，**绝不向目标机发命令**：那里的 `dsh web` 归
	 * systemd / docker / 操作者自己管，VCPDeck 停它属于越权。
	 */
	async detach(clientId: string): Promise<DshWebStatus> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: clientId },
		});
		if (!client) {
			throw fail("DSH_WEB_CLIENT_OFFLINE", `Client "${clientId}" 不存在`, 404);
		}
		const row = client as unknown as { dshWebFrpMappingId?: string | null };
		// 历史数据可能残留映射引用：只清引用，不删映射（那属于外部实例的入口）。
		void row;
		await this.updateClient(clientId, {
			dshWebState: "stopped",
			dshWebUrl: null,
			dshWebPort: null,
			dshWebFrpMappingId: null,
			dshWebMode: "managed",
		});
		return {
			clientId,
			state: "stopped",
			port: null,
			url: null,
			mode: "managed",
		};
	}

	/** Client 结果回报：按 requestId 结算挂起的命令。 */
	async handleResult(socketId: string, result: DshWebCommandResult): Promise<void> {
		const entry = this.pending.get(result.requestId);
		if (!entry) return;
		this.pending.delete(result.requestId);
		clearTimeout(entry.timer);
		// socketId 仅用于排障，不参与路由：requestId 已经是随机且一次性的。
		void socketId;
		entry.resolve(result);
	}

	/**
	 * Client 离线：通道不可再维持，标失败并清掉对外地址。
	 *
	 * **保留 `dshWebPort` 与 `dshWebFrpMappingId`**：
	 * - 进程可能还活着（Client 重启不等于进程退出），端口是下一次「停止并清理」
	 *   唯一能定位残留的线索；
	 * - 这里也不去删 FRP 映射：`deleteMapping` 需要 Client 在线确认，离线时删只会
	 *   留下永远 `deleting` 的记录。等 Client 回来由 `stop()` 一起清。
	 */
	async handleClientOffline(clientId: string): Promise<void> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: clientId },
		});
		const row = client as unknown as { dshWebState?: string } | null;
		if (!row) return;
		if (row.dshWebState !== "running" && row.dshWebState !== "starting") {
			return;
		}
		await this.updateClient(clientId, {
			dshWebState: "failed",
			dshWebUrl: null,
		});
	}

	/** 删除映射并把 dispatch 下发给 Client（删库不等于 frpc 撤了代理）。 */
	private async deleteMappingQuietly(mappingId: string): Promise<void> {
		await this.deps.frp
			.deleteMapping(mappingId)
			.then((removed) => {
				if (removed) this.deps.dispatch?.(removed.dispatch);
			})
			.catch(() => undefined);
	}

	/** 只发不收：回滚用，不登记 pending，避免错误路径被超时拖住。 */
	private sendOnly(socketId: string, command: DshWebCommand): void {
		this.deps.send?.(socketId, command);
	}

	private allocatePort(): number {
		return DEFAULT_PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
	}

	private async command(
		socketId: string,
		command: DshWebCommand,
	): Promise<DshWebCommandResult> {
		const send = this.deps.send;
		if (!send) {
			throw fail("DSH_WEB_COMMAND_FAILED", "Client 通道未就绪", 503);
		}
		return new Promise<DshWebCommandResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(command.requestId);
				reject(fail("DSH_WEB_COMMAND_FAILED", "等待 Client 回执超时", 504));
			}, this.deps.startTimeoutMs ?? 30_000);
			this.pending.set(command.requestId, { resolve, reject, timer });
			send(socketId, command);
		});
	}

	private async updateClient(
		clientId: string,
		data: Record<string, unknown>,
	): Promise<void> {
		await this.deps.prisma.client.update({ where: { id: clientId }, data });
	}
}

function parseCapabilities(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as string[]) : [];
	} catch {
		return [];
	}
}

/** 组装对外地址：FRP 的 host:port 是 TCP，URL 需要补协议与 token。 */
export function buildDshWebUrl(publicUrl: string, token: string): string {
	const base = /^https?:\/\//.test(publicUrl)
		? publicUrl.replace(/\/$/, "")
		: `http://${publicUrl}`;
	return `${base}/?token=${encodeURIComponent(token)}`;
}
