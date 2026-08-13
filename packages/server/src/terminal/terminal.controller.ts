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
import { Actor } from "../auth/actor.decorator.js";
import { TerminalService } from "./terminal.service.js";
import { TerminalAuditService } from "./terminal-audit.service.js";
import type {
	ActorContext,
	PaginatedResult,
	TerminalAuditInfo,
	TerminalSessionCreateRequest,
	TerminalSessionInfo,
	TerminalShellInfo,
} from "@vcpdeck/shared";
import { parseTerminalSessionCreateRequest, safeTerminalErrorMessage } from "@vcpdeck/shared";

/** 稳定错误码 → HTTP 状态映射。 */
const TERMINAL_HTTP_STATUS: Record<string, number> = {
	TERMINAL_PROTOCOL_INVALID: 400,
	TERMINAL_INPUT_TOO_LARGE: 400,
	TERMINAL_SESSION_NOT_FOUND: 404,
	TERMINAL_SESSION_ENDED: 409,
	TERMINAL_SESSION_LIMIT_REACHED: 409,
	TERMINAL_READ_ONLY: 409,
	TERMINAL_CONTROL_PROTECTED: 409,
	TERMINAL_CONTROL_CONFLICT: 409,
	TERMINAL_PTY_SPAWN_FAILED: 422,
	TERMINAL_SNAPSHOT_FAILED: 422,
	TERMINAL_CLIENT_OFFLINE: 503,
	TERMINAL_UNSUPPORTED: 503,
	TERMINAL_NATIVE_BACKEND_UNAVAILABLE: 503,
	TERMINAL_REQUEST_TIMEOUT: 504,
};

function mapTerminalError(error: unknown): HttpException {
	const code = (error as { code?: unknown }).code;
	const stableCode = typeof code === "string" ? code : "TERMINAL_UNKNOWN";
	const status = TERMINAL_HTTP_STATUS[stableCode] ?? 500;
	// 未知错误不泄露内部细节；已知错误使用安全文案
	const message =
		status === 500
			? "Terminal operation failed"
			: safeTerminalErrorMessage((error as { message?: unknown }).message);
	if (status === 404) return new NotFoundException({ code: stableCode, message });
	if (status === 409) return new ConflictException({ code: stableCode, message });
	if (status === 503) return new ServiceUnavailableException({ code: stableCode, message });
	if (status === 400) return new BadRequestException({ code: stableCode, message });
	return new HttpException({ code: stableCode, message }, status);
}

function page(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = parseInt(value, 10);
	if (Number.isNaN(n) || n < 1) return fallback;
	return n;
}

/** 终端会话 REST API（机器范围内）。 */
@Controller("api/clients/:clientId/terminals")
export class TerminalController {
	constructor(
		@Inject(TerminalService) private readonly service: TerminalService,
		@Inject(TerminalAuditService) private readonly auditService: TerminalAuditService,
	) {}

	@Get("shells")
	async shells(@Param("clientId") clientId: string, @Actor() _actor: ActorContext): Promise<TerminalShellInfo[]> {
		try {
			return await this.service.listShells(clientId);
		} catch (error) {
			throw mapTerminalError(error);
		}
	}

	@Get()
	async list(
		@Param("clientId") clientId: string,
		@Query("page") pageStr: string | undefined = undefined,
		@Query("pageSize") pageSizeStr: string | undefined = undefined,
		@Actor() _actor: ActorContext,
	): Promise<PaginatedResult<TerminalSessionInfo>> {
		const pageSize = Math.min(100, page(pageSizeStr, 20));
		try {
			return await this.service.listSessions(clientId, page(pageStr, 1), pageSize);
		} catch (error) {
			throw mapTerminalError(error);
		}
	}

	@Post()
	async create(
		@Param("clientId") clientId: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<TerminalSessionInfo> {
		let parsed: TerminalSessionCreateRequest;
		try {
			parsed = parseTerminalSessionCreateRequest(body);
		} catch {
			throw new BadRequestException({
				code: "TERMINAL_PROTOCOL_INVALID",
				message: "Invalid terminal create request",
			});
		}
		try {
			return await this.service.createSession(clientId, parsed, actor);
		} catch (error) {
			throw mapTerminalError(error);
		}
	}

	@Get(":sessionId")
	async get(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Actor() _actor: ActorContext,
	): Promise<TerminalSessionInfo> {
		try {
			return await this.service.getSession(clientId, sessionId);
		} catch (error) {
			throw mapTerminalError(error);
		}
	}

	@Delete(":sessionId")
	async remove(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Actor() actor: ActorContext,
	): Promise<TerminalSessionInfo> {
		try {
			return await this.service.closeSession(clientId, sessionId, actor);
		} catch (error) {
			throw mapTerminalError(error);
		}
	}

	@Get(":sessionId/audit")
	async audit(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("page") pageStr: string | undefined = undefined,
		@Query("pageSize") pageSizeStr: string | undefined = undefined,
		@Actor() _actor: ActorContext,
	): Promise<PaginatedResult<TerminalAuditInfo>> {
		const pageSize = Math.min(100, page(pageSizeStr, 20));
		try {
			await this.service.getSession(clientId, sessionId);
			return await this.auditService.list({ sessionId, clientId }, page(pageStr, 1), pageSize);
		} catch (error) {
			throw mapTerminalError(error);
		}
	}
}
