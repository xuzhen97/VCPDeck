import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpException,
	Inject,
	Param,
	Patch,
	Post,
	Query,
} from "@nestjs/common";
import {
	A2aProtocolError,
	type ActorContext,
	type AgentPlacementInfo,
	type AgentPlacementInput,
	type AgentPlacementUpdate,
	parseAgentPlacementInput,
	parseAgentPlacementUpdate,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import {
	AgentRegistryError,
	AgentRegistryService,
} from "./agent-registry.service.js";

function pageOf(value: unknown): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function clampPageSize(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) return 20;
	return Math.min(100, Math.max(1, parsed));
}

function httpError(error: unknown): HttpException {
	if (error instanceof A2aProtocolError) {
		return new BadRequestException({
			code: "INVALID_AGENT_PLACEMENT",
			message: error.message,
		});
	}
	if (error instanceof AgentRegistryError) {
		return new HttpException(
			{ code: error.code, message: error.message },
			error.statusCode,
		);
	}
	throw error;
}

/** Agent placement 管理 REST；写操作沿用全局 AuthGuard。 */
@Controller("api/agents")
export class AgentRegistryController {
	constructor(
		@Inject(AgentRegistryService) private readonly agents: AgentRegistryService,
	) {}

	@Get()
	async list(
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		return this.agents.list(pageOf(page), clampPageSize(pageSize));
	}

	@Get(":id")
	async get(@Param("id") id: string): Promise<AgentPlacementInfo> {
		try {
			return await this.agents.get(id);
		} catch (error) {
			throw httpError(error);
		}
	}

	@Post()
	async create(
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<AgentPlacementInfo> {
		let input: AgentPlacementInput;
		try {
			input = parseAgentPlacementInput(body);
		} catch (error) {
			throw httpError(error);
		}
		try {
			return await this.agents.create(input, actor);
		} catch (error) {
			throw httpError(error);
		}
	}

	@Patch(":id")
	async update(
		@Param("id") id: string,
		@Body() body: unknown,
	): Promise<AgentPlacementInfo> {
		let input: AgentPlacementUpdate;
		try {
			input = parseAgentPlacementUpdate(body);
		} catch (error) {
			throw httpError(error);
		}
		try {
			return await this.agents.update(id, input);
		} catch (error) {
			throw httpError(error);
		}
	}

	@Delete(":id")
	async remove(@Param("id") id: string): Promise<{ ok: true }> {
		try {
			await this.agents.remove(id);
			return { ok: true };
		} catch (error) {
			throw httpError(error);
		}
	}
}
