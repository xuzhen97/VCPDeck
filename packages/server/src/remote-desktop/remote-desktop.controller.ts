import {
	BadRequestException,
	Body,
	ConflictException,
	Controller,
	Delete,
	Get,
	HttpException,
	Inject,
	NotFoundException,
	Param,
	Post,
	Query,
	ServiceUnavailableException,
} from "@nestjs/common";
import {
	parseRemoteDesktopSessionCreateRequest,
	safeRemoteDesktopErrorMessage,
	type ActorContext,
	type PaginatedResult,
	type RemoteDesktopAuditInfo,
	type RemoteDesktopSessionCreateRequest,
	type RemoteDesktopSessionInfo,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { RemoteDesktopAuditService } from "./remote-desktop-audit.service.js";
import { RemoteDesktopService } from "./remote-desktop.service.js";

const REMOTE_DESKTOP_HTTP_STATUS: Record<string, number> = {
	REMOTE_DESKTOP_PROTOCOL_MISMATCH: 400,
	REMOTE_DESKTOP_SIGNAL_LIMIT: 400,
	REMOTE_DESKTOP_SESSION_LIMIT: 409,
	REMOTE_DESKTOP_ATTACHMENT_LIMIT: 409,
	REMOTE_DESKTOP_TAKEOVER_CONFLICT: 409,
	REMOTE_DESKTOP_NO_ACTIVE_SESSION: 404,
	REMOTE_DESKTOP_HOST_OFFLINE: 503,
	REMOTE_DESKTOP_UNSUPPORTED: 503,
	REMOTE_DESKTOP_CAPTURE_FAILED: 422,
	REMOTE_DESKTOP_NO_DISPLAY: 422,
	REMOTE_DESKTOP_INPUT_UNAVAILABLE: 422,
	REMOTE_DESKTOP_ENCODER_UNAVAILABLE: 422,
	REMOTE_DESKTOP_VIRTUAL_DISPLAY_FAILED: 422,
	REMOTE_DESKTOP_MIGRATION_FAILED: 503,
};

function page(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function mapRemoteDesktopError(error: unknown): HttpException {
	const code = (error as { code?: unknown }).code;
	const stableCode = typeof code === "string" ? code : "REMOTE_DESKTOP_UNKNOWN";
	const status = REMOTE_DESKTOP_HTTP_STATUS[stableCode] ?? 500;
	const message = status === 500
		? "Remote Desktop operation failed"
		: safeRemoteDesktopErrorMessage((error as { message?: unknown }).message);
	if (status === 400) return new BadRequestException({ code: stableCode, message });
	if (status === 404) return new NotFoundException({ code: stableCode, message });
	if (status === 409) return new ConflictException({ code: stableCode, message });
	if (status === 503) return new ServiceUnavailableException({ code: stableCode, message });
	return new HttpException({ code: stableCode, message }, status);
}

/** 浏览器远程桌面会话 REST API；媒体、输入和信令不经过 REST。 */
@Controller("api/clients/:clientId/desktop-sessions")
export class RemoteDesktopController {
	constructor(
		@Inject(RemoteDesktopService) private readonly service: RemoteDesktopService,
		@Inject(RemoteDesktopAuditService) private readonly auditService: RemoteDesktopAuditService,
	) {}

	@Get()
	async list(
		@Param("clientId") clientId: string,
		@Query("page") pageValue: string | undefined = undefined,
		@Query("pageSize") pageSizeValue: string | undefined = undefined,
		@Actor() _actor: ActorContext,
	): Promise<PaginatedResult<RemoteDesktopSessionInfo>> {
		try {
			return await this.service.listSessions(clientId, page(pageValue, 1), Math.min(100, page(pageSizeValue, 20)));
		} catch (error) {
			throw mapRemoteDesktopError(error);
		}
	}

	@Post()
	async create(
		@Param("clientId") clientId: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<RemoteDesktopSessionInfo> {
		let request: RemoteDesktopSessionCreateRequest;
		try {
			request = parseRemoteDesktopSessionCreateRequest(body);
		} catch {
			throw new BadRequestException({
				code: "REMOTE_DESKTOP_PROTOCOL_MISMATCH",
				message: "Invalid Remote Desktop create request",
			});
		}
		try {
			return await this.service.createSession(clientId, request, actor);
		} catch (error) {
			throw mapRemoteDesktopError(error);
		}
	}

	@Get(":sessionId")
	async get(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Actor() _actor: ActorContext,
	): Promise<RemoteDesktopSessionInfo> {
		try {
			return await this.service.getSession(clientId, sessionId);
		} catch (error) {
			throw mapRemoteDesktopError(error);
		}
	}

	@Delete(":sessionId")
	async remove(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Actor() actor: ActorContext,
	): Promise<RemoteDesktopSessionInfo> {
		try {
			return await this.service.closeSession(clientId, sessionId, actor);
		} catch (error) {
			throw mapRemoteDesktopError(error);
		}
	}

	@Get(":sessionId/audit")
	async audit(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("page") pageValue: string | undefined = undefined,
		@Query("pageSize") pageSizeValue: string | undefined = undefined,
		@Actor() _actor: ActorContext,
	): Promise<PaginatedResult<RemoteDesktopAuditInfo>> {
		try {
			await this.service.getSession(clientId, sessionId);
			return await this.auditService.list(
				{ sessionId, clientId },
				page(pageValue, 1),
				Math.min(100, page(pageSizeValue, 20)),
			);
		} catch (error) {
			throw mapRemoteDesktopError(error);
		}
	}
}
