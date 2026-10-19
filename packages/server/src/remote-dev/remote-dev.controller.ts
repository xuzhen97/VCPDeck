import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpException,
	Inject,
	Param,
	Post,
	Query,
	Optional,
} from "@nestjs/common";
import {
	type ActorContext,
	type RemoteDevPortCreateRequest,
	type RemoteDevPortInfo,
	type RemoteDevSessionCreateRequest,
	type RemoteDevSessionInfo,
	type RemoteDevState,
	type RemoteDevForwardToken,
	REMOTE_DEV_STATES,
	RemoteDevProtocolError,
	parseRemoteDevPortCreateRequest,
	parseRemoteDevSessionCreateRequest,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { RemoteDevAttachmentService } from "./remote-dev-attachment.service.js";
import { RemoteDevForwardGateway } from "./remote-dev-forward.gateway.js";
import { RemoteDevPortService } from "./remote-dev-port.service.js";
import { RemoteDevError, RemoteDevService } from "./remote-dev.service.js";

function pageOf(value: unknown): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function pageSizeOf(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) return 20;
	return Math.min(100, Math.max(1, parsed));
}

function httpError(cause: unknown): HttpException {
	if (cause instanceof RemoteDevProtocolError) {
		return new BadRequestException({
			code: "RDS_PROTOCOL_INVALID",
			message: cause.message,
		});
	}
	if (cause instanceof RemoteDevError) {
		return new HttpException(
			{ code: cause.code, message: cause.message },
			cause.statusCode,
		);
	}
	throw cause;
}

function stateOf(value: string | undefined): RemoteDevState | undefined {
	if (value === undefined) return undefined;
	if (!REMOTE_DEV_STATES.includes(value as RemoteDevState)) {
		throw new BadRequestException({
			code: "RDS_PROTOCOL_INVALID",
			message: "未知 RDS 状态",
		});
	}
	return value as RemoteDevState;
}

@Controller("api/remote-dev/sessions")
export class RemoteDevController {
	constructor(
		@Inject(RemoteDevService) private readonly service: RemoteDevService,
		@Inject(RemoteDevPortService) private readonly portTokens: RemoteDevPortService,
		@Optional()
		@Inject(RemoteDevForwardGateway)
		private readonly forwarder?: RemoteDevForwardGateway,
		@Optional()
		@Inject(RemoteDevAttachmentService)
		private readonly attachments?: RemoteDevAttachmentService,
	) {}

	@Post()
	async create(
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<RemoteDevSessionInfo> {
		try {
			const input: RemoteDevSessionCreateRequest =
				parseRemoteDevSessionCreateRequest(body);
			return await this.service.create(input, actor);
		} catch (cause) {
			throw httpError(cause);
		}
	}

	@Get()
	async list(
		@Query("clientId") clientId?: string,
		@Query("state") state?: string,
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		return this.service.list(
			{
				...(clientId ? { clientId } : {}),
				...(state ? { state: stateOf(state) } : {}),
			},
			pageOf(page),
			pageSizeOf(pageSize),
		);
	}

	@Get(":id")
	async get(@Param("id") id: string): Promise<RemoteDevSessionInfo> {
		try {
			return await this.service.get(id);
		} catch (cause) {
			throw httpError(cause);
		}
	}

	@Delete(":id")
	async close(
		@Param("id") id: string,
		@Actor() actor: ActorContext,
	): Promise<RemoteDevSessionInfo> {
		try {
			const ports = await this.service.ports(id);
			try {
				return await this.service.close(id, actor);
			} finally {
				this.attachments?.clear(id);
				for (const port of ports) {
					this.portTokens.revokePort(port.portId);
					this.forwarder?.disconnectPort(port.portId);
				}
			}
		} catch (cause) {
			throw httpError(cause);
		}
	}

	@Get(":id/ports")
	async ports(@Param("id") id: string): Promise<RemoteDevPortInfo[]> {
		try {
			return await this.service.ports(id);
		} catch (cause) {
			throw httpError(cause);
		}
	}

	@Post(":id/ports")
	async openPort(
		@Param("id") id: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<RemoteDevPortInfo> {
		try {
			const input: RemoteDevPortCreateRequest =
				parseRemoteDevPortCreateRequest(body);
			return await this.service.openPort(id, input, actor);
		} catch (cause) {
			throw httpError(cause);
		}
	}

	@Delete(":id/ports/:portId")
	async closePort(
		@Param("id") id: string,
		@Param("portId") portId: string,
		@Actor() actor: ActorContext,
	): Promise<RemoteDevPortInfo> {
		try {
			const port = await this.service.closePort(id, portId, actor);
			this.portTokens.revokePort(portId);
			this.forwarder?.disconnectPort(portId);
			return port;
		} catch (cause) {
			throw httpError(cause);
		}
	}

	@Post(":id/ports/:portId/forward-token")
	async forwardToken(
		@Param("id") id: string,
		@Param("portId") portId: string,
		@Actor() actor: ActorContext,
	): Promise<RemoteDevForwardToken> {
		try {
			return await this.portTokens.issueForwardToken(id, portId, actor);
		} catch (cause) {
			throw httpError(cause);
		}
	}
}
