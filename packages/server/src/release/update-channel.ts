/**
 * ClientUpdateChannel 网关实现。
 *
 * 与 PiRequestBroker 同模式：不直接依赖 ClientGateway（避免 ReleaseModule ↔
 * EventsModule provider 循环），由 ClientGateway.afterInit 将发送函数绑定进来。
 * Client 更新指令经 room（clientId）下发；详见 docs/design/release-and-update.md。
 */
import { Inject, Injectable } from "@nestjs/common";
import type { ServerShutdownNotice, UpdateRequest } from "@vcpdeck/shared";
import { ClientService } from "../client/client.service.js";
import type { ClientUpdateChannel } from "./release.orchestrator.js";

export interface UpdateEmitters {
	sendUpdateRequest: (clientId: string, req: UpdateRequest) => void;
	broadcastShutdown: (notice: ServerShutdownNotice) => void;
}

@Injectable()
export class GatewayUpdateChannel implements ClientUpdateChannel {
	private emitters: UpdateEmitters | null = null;

	constructor(
		@Inject(ClientService) private readonly clients: ClientService,
	) {}

	/** 由 ClientGateway.afterInit 调用，绑定真实发送通道 */
	bindEmitters(emitters: UpdateEmitters): void {
		this.emitters = emitters;
	}

	async listOnlineClients(): Promise<
		Array<{ clientId: string; clientVersion: string; os: string }>
	> {
		const online = await this.clients.listOnline();
		return online.map((c) => ({
			clientId: c.clientId,
			clientVersion: c.clientVersion,
			os: c.os,
		}));
	}

	sendUpdateRequest(clientId: string, req: UpdateRequest): void {
		if (!this.emitters) {
			throw new Error("更新通道未绑定（gateway afterInit 尚未执行）");
		}
		this.emitters.sendUpdateRequest(clientId, req);
	}

	broadcastShutdown(notice: ServerShutdownNotice): void {
		if (!this.emitters) {
			throw new Error("更新通道未绑定（gateway afterInit 尚未执行）");
		}
		this.emitters.broadcastShutdown(notice);
	}
}
