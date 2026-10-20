import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	ACP_PERMISSION_EXTENSION_URI,
	type A2aAgentCard,
	type A2aAgentSkill,
	type ActorContext,
	type AgentPlacementInfo,
	type AgentPlacementInput,
	type AgentPlacementUpdate,
	type PaginatedResult,
	type ResolvedAgentPlacement,
} from "@vcpdeck/shared";
import type { Prisma } from "../../generated/client/index.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** Agent Registry 业务错误；Controller 原样映射 code 与 statusCode。 */
export class AgentRegistryError extends Error {
	constructor(
		readonly code:
			| "AGENT_NOT_FOUND"
			| "AGENT_DISABLED"
			| "AGENT_AMBIGUOUS"
			| "AGENT_CLIENT_UNKNOWN"
			| "AGENT_IN_USE",
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "AgentRegistryError";
	}
}

export interface AgentRegistryDeps {
	prisma: PrismaService;
	now?: () => Date;
}

interface AgentPlacementRow {
	id: string;
	agentId: string;
	name: string;
	adapter: string;
	clientId: string;
	command: string;
	args: string;
	cwd: string;
	workspaceRoots: string;
	skills: string;
	enabled: boolean;
	createdAt: Date;
	updatedAt: Date;
}

function parseJsonStringArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function toInfo(row: AgentPlacementRow): AgentPlacementInfo {
	return {
		id: row.id,
		agentId: row.agentId,
		name: row.name,
		adapter: row.adapter === "cli" ? "cli" : "acp",
		clientId: row.clientId,
		workspaceRoots: parseJsonStringArray(row.workspaceRoots),
		skills: parseJsonStringArray(row.skills),
		enabled: row.enabled,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function placementId(): string {
	return `ap_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Agent placement 注册表：Server 侧受控配置，不是 Client 能力清单。 */
@Injectable()
export class AgentRegistryService {
	private readonly deps: AgentRegistryDeps;

	constructor(@Inject(PrismaService) prisma: PrismaService) {
		this.deps = { prisma };
	}

	/** 测试构造：注入 fake Prisma。 */
	static withDeps(deps: AgentRegistryDeps): AgentRegistryService {
		const service = new AgentRegistryService(null as unknown as PrismaService);
		(service as unknown as { deps: AgentRegistryDeps }).deps = deps;
		return service;
	}

	private get prisma(): PrismaService {
		return this.deps.prisma;
	}

	/** 分页列出 placement；包含 clientId 供操作者筛选，不包含 command/cwd。 */
	async list(page: number, pageSize: number): Promise<PaginatedResult<AgentPlacementInfo>> {
		const [rows, total] = await Promise.all([
			this.prisma.agentPlacement.findMany({
				orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.prisma.agentPlacement.count(),
		]);
		return {
			data: rows.map((row) => toInfo(row as AgentPlacementRow)),
			total,
			page,
			pageSize,
			totalPages: Math.max(1, Math.ceil(total / pageSize)),
		};
	}

	/** 读取单条 placement。 */
	async get(id: string): Promise<AgentPlacementInfo> {
		const row = await this.prisma.agentPlacement.findUnique({ where: { id } });
		if (!row) {
			throw new AgentRegistryError("AGENT_NOT_FOUND", "Agent placement 不存在", 404);
		}
		return toInfo(row as AgentPlacementRow);
	}

	/** 创建 placement；Client 必须已注册。 */
	async create(
		input: AgentPlacementInput,
		_actor: ActorContext | null,
	): Promise<AgentPlacementInfo> {
		const client = await this.prisma.client.findUnique({
			where: { id: input.clientId },
			select: { id: true },
		});
		if (!client) {
			throw new AgentRegistryError(
				"AGENT_CLIENT_UNKNOWN",
				`Client "${input.clientId}" 不存在`,
				404,
			);
		}
		const data: Prisma.AgentPlacementUncheckedCreateInput = {
			id: placementId(),
			agentId: input.agentId,
			name: input.name,
			adapter: input.adapter,
			clientId: input.clientId,
			command: input.command,
			args: JSON.stringify(input.args),
			cwd: input.cwd,
			workspaceRoots: JSON.stringify(input.workspaceRoots),
			skills: JSON.stringify(input.skills ?? []),
			enabled: input.enabled ?? true,
		};
		const row = await this.prisma.agentPlacement.create({ data });
		return toInfo(row as AgentPlacementRow);
	}

	/** 更新 placement；agentId/clientId 不允许修改。 */
	async update(
		id: string,
		input: AgentPlacementUpdate,
	): Promise<AgentPlacementInfo> {
		await this.get(id);
		const data: Prisma.AgentPlacementUncheckedUpdateInput = {};
		if (input.name !== undefined) data.name = input.name;
		if (input.adapter !== undefined) data.adapter = input.adapter;
		if (input.command !== undefined) data.command = input.command;
		if (input.args !== undefined) data.args = JSON.stringify(input.args);
		if (input.cwd !== undefined) data.cwd = input.cwd;
		if (input.workspaceRoots !== undefined) {
			data.workspaceRoots = JSON.stringify(input.workspaceRoots);
		}
		if (input.skills !== undefined) data.skills = JSON.stringify(input.skills);
		if (input.enabled !== undefined) data.enabled = input.enabled;
		const row = await this.prisma.agentPlacement.update({ where: { id }, data });
		return toInfo(row as AgentPlacementRow);
	}

	/** 删除未被 Task 引用的 placement；有历史 Task 时拒绝，避免破坏审计。 */
	async remove(id: string): Promise<void> {
		await this.get(id);
		const tasks = await this.prisma.task.count({ where: { agentPlacementId: id } });
		if (tasks > 0) {
			throw new AgentRegistryError(
				"AGENT_IN_USE",
				"Agent placement 已被 Task 引用，不能删除；请禁用",
				409,
			);
		}
		await this.prisma.agentPlacement.delete({ where: { id } });
	}

	/** 按 placement id 读取可执行配置；只供 Server 派发使用。 */
	async resolveById(id: string): Promise<ResolvedAgentPlacement> {
		const row = await this.prisma.agentPlacement.findUnique({ where: { id } });
		if (!row) {
			throw new AgentRegistryError("AGENT_NOT_FOUND", "Agent placement 不存在", 404);
		}
		if (!row.enabled) {
			throw new AgentRegistryError("AGENT_DISABLED", "Agent 已禁用", 409);
		}
		return {
			id: row.id,
			agentId: row.agentId,
			adapter: row.adapter === "cli" ? "cli" : "acp",
			clientId: row.clientId,
			command: row.command,
			args: parseJsonStringArray(row.args),
			cwd: row.cwd,
			workspaceRoots: parseJsonStringArray(row.workspaceRoots),
			skills: parseJsonStringArray(row.skills),
		};
	}

	/** 解析逻辑 agentId；歧义/禁用/不存在都 fail closed。 */
	async resolve(agentId: string): Promise<ResolvedAgentPlacement> {
		const rows = await this.prisma.agentPlacement.findMany({
			where: { agentId },
		});
		if (rows.length === 0) {
			throw new AgentRegistryError("AGENT_NOT_FOUND", "Agent 不存在", 404);
		}
		const enabled = rows.filter((row) => row.enabled);
		if (enabled.length === 0) {
			throw new AgentRegistryError("AGENT_DISABLED", "Agent 已禁用", 409);
		}
		if (enabled.length > 1) {
			throw new AgentRegistryError(
				"AGENT_AMBIGUOUS",
				"Agent 存在多个启用的 placement",
				409,
			);
		}
		const row = enabled[0] as AgentPlacementRow;
		return {
			id: row.id,
			agentId: row.agentId,
			adapter: row.adapter === "cli" ? "cli" : "acp",
			clientId: row.clientId,
			command: row.command,
			args: parseJsonStringArray(row.args),
			cwd: row.cwd,
			workspaceRoots: parseJsonStringArray(row.workspaceRoots),
			skills: parseJsonStringArray(row.skills),
		};
	}

	/** 生成对外 Agent Card；只投影逻辑 agentId/技能，不泄露 Client/命令/路径。 */
	async agentCard(baseUrl: string): Promise<A2aAgentCard> {
		const rows = await this.prisma.agentPlacement.findMany({
			where: { enabled: true },
			orderBy: [{ agentId: "asc" }, { id: "asc" }],
		});
		const skills = new Map<string, A2aAgentSkill>();
		for (const row of rows as AgentPlacementRow[]) {
			// 目录条目：SendMessage 必须带 metadata.agentId，调用方得先知道有哪些可用。
			// 只暴露 agentId 与 adapter，不暴露 clientId / command / cwd。
			const entry = `agent:${row.agentId}`;
			if (!skills.has(entry)) {
				skills.set(entry, {
					id: entry,
					name: row.agentId,
					description: `在目标机上运行 ${row.agentId}（adapter=${row.adapter}）；派活时 metadata.agentId 填 "${row.agentId}"`,
					tags: ["remote-agent", row.adapter],
				});
			}
			const declared = parseJsonStringArray(row.skills);
			for (const skill of declared) {
				if (!skills.has(skill)) {
					skills.set(skill, {
						id: skill,
						name: skill,
						description: `VCPDeck agent ${row.agentId}`,
						tags: [skill],
					});
				}
			}
		}
		return {
			name: "VCPDeck A2A Hub",
			description: "VCPDeck 跨机器 agent 任务入口",
			version: "1.0.0",
			supportedInterfaces: [
				{
					url: `${baseUrl.replace(/\/$/, "")}/api/a2a`,
					protocolBinding: "JSONRPC",
					protocolVersion: "1.0",
				},
			],
			capabilities: {
				streaming: false,
				pushNotifications: false,
				extensions: [
					{
						uri: ACP_PERMISSION_EXTENSION_URI,
						description: "ACP permission decision envelope",
						required: false,
					},
				],
			},
			defaultInputModes: ["text/plain"],
			defaultOutputModes: ["text/plain"],
			skills: [...skills.values()],
		};
	}
}
