import {
	Body,
	Controller,
	Delete,
	Get,
	Header,
	HttpException,
	Inject,
	Param,
	Post,
	Put,
} from "@nestjs/common";
import type {
	ActorContext,
	TunnelConfigInfo,
	TunnelSessionCreated,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { TunnelConfigError, TunnelConfigService } from "./tunnel-config.service.js";
import { TunnelSessionError, TunnelSessionService } from "./tunnel-session.service.js";

/** P2P 隧道 REST 控制面：ICE 配置 + 临时 Session 创建/关闭。 */
@Controller("api/tunnels")
export class TunnelController {
	constructor(
		@Inject(TunnelConfigService) private readonly config: TunnelConfigService,
		@Inject(TunnelSessionService) private readonly sessions: TunnelSessionService,
	) {}

	@Get("config")
	getConfig(): Promise<TunnelConfigInfo> {
		return this.guarded(() => this.config.get());
	}

	@Put("config")
	updateConfig(@Body() raw: unknown): Promise<TunnelConfigInfo> {
		return this.guarded(() => this.config.update(raw));
	}

	@Post()
	@Header("Cache-Control", "no-store")
	create(@Body() raw: unknown, @Actor() actor: ActorContext): Promise<TunnelSessionCreated> {
		return this.guarded(() => this.sessions.create(raw, actor));
	}

	@Delete(":sessionId")
	close(
		@Param("sessionId") sessionId: string,
		@Actor() actor: ActorContext,
	): Promise<{ closed: true }> {
		return this.guarded(() => this.sessions.close(sessionId, actor));
	}

	private guarded<T>(op: () => Promise<T>): Promise<T> {
		return op().catch((error: unknown) => {
			throw this.toHttp(error);
		});
	}

	private toHttp(error: unknown): HttpException {
		if (error instanceof HttpException) return error;
		if (error instanceof TunnelConfigError || error instanceof TunnelSessionError) {
			return new HttpException({ code: error.code, message: error.message }, error.statusCode);
		}
		if (error instanceof Error) {
			return new HttpException({ code: "TUNNEL_REQUEST_INVALID", message: error.message }, 400);
		}
		return new HttpException({ code: "TUNNEL_INTERNAL", message: "隧道操作失败" }, 500);
	}
}
