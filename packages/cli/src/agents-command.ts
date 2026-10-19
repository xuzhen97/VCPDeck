/** `vcpdeck agents` 命令组：查询与登记逻辑 agent placement。 */
import type { AgentPlacementInput } from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { resolveClientId } from "./client-resolver.js";
import type { ConfigPaths } from "./config.js";
import { resolveEnvironment } from "./environment.js";
import { envOverrideOf } from "./features-command.js";
import { formatTable } from "./table.js";

export interface AgentsCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	sdk?: VcpDeckClient;
	/** 测试注入：把机器名称或 clientId 解析为权威 clientId。 */
	resolveClientIdFn?: (filter: string) => Promise<string>;
}

export function agentsUsage(): string {
	return [
		"Agents 命令:",
		"  vcpdeck agents list [--env=<name>] [--json]",
		"  vcpdeck agents create --client=<name|id> --agent=<slug> --command=<cmd> [--arg=<v>]... [--workspace-root=<dir>]...",
		"      [--name=<显示名>] [--adapter=acp|cli] [--cwd=<dir>] [--skill=<s>]... [--disabled] [--env=<name>] [--json]",
		"  登记的是 Server 侧受控 placement；目标机器上必须先安装对应 agent 命令。",
	].join("\n");
}

async function resolveClient(
	context: AgentsCommandContext,
	argv: string[],
): Promise<VcpDeckClient> {
	return (
		context.sdk ??
		(await createAuthenticatedClient(
			await resolveEnvironment({
				environment: envOverrideOf(argv),
				paths: context.paths,
				processEnv: context.processEnv,
			}),
		))
	);
}

export async function runAgentsCommand(
	subcommand: string | undefined,
	argv: string[],
	context: AgentsCommandContext = {},
): Promise<void> {
	const log = context.log ?? console.log;
	if (subcommand === "list") {
		await runList(argv, context, log);
		return;
	}
	if (subcommand === "create") {
		await runCreate(argv, context, log);
		return;
	}
	throw new Error(agentsUsage());
}

async function runList(
	argv: string[],
	context: AgentsCommandContext,
	log: (message: string) => void,
): Promise<void> {
	const { options } = parseCommandArgs(argv, {
		value: ["env", "environment"],
		boolean: ["json"],
	});
	const client = await resolveClient(context, argv);
	const result = await client.agents.list();
	if (options.json) {
		log(JSON.stringify(result, null, 2));
		return;
	}
	const rows = result.data.map((agent) => ({
		agent: agent.agentId,
		name: agent.name,
		adapter: agent.adapter,
		client: agent.clientId,
		enabled: String(agent.enabled),
	}));
	log(formatTable(rows, ["agent", "name", "adapter", "client", "enabled"]));
}

async function runCreate(
	argv: string[],
	context: AgentsCommandContext,
	log: (message: string) => void,
): Promise<void> {
	const { options, multi } = parseCommandArgs(argv, {
		value: [
			"client",
			"agent",
			"name",
			"command",
			"adapter",
			"cwd",
			"env",
			"environment",
		],
		boolean: ["json", "disabled"],
		multiValue: ["arg", "workspace-root", "skill"],
	});
	const clientFilter = stringOption(options, "client");
	const agentId = stringOption(options, "agent");
	const command = stringOption(options, "command");
	if (!clientFilter || !agentId || !command) {
		throw new Error(agentsUsage());
	}
	const adapterRaw = stringOption(options, "adapter") ?? "acp";
	if (adapterRaw !== "acp" && adapterRaw !== "cli") {
		throw new Error(`adapter 必须是 acp 或 cli\n\n${agentsUsage()}`);
	}
	const workspaceRoots = multi["workspace-root"] ?? [];
	const cwd = stringOption(options, "cwd") ?? workspaceRoots[0];
	if (!cwd) {
		throw new Error(`需要 --cwd 或至少一个 --workspace-root\n\n${agentsUsage()}`);
	}
	const input: AgentPlacementInput = {
		agentId,
		name: stringOption(options, "name") ?? agentId,
		adapter: adapterRaw,
		clientId: await resolveClientIdFor(context, argv, clientFilter),
		command,
		args: multi.arg ?? [],
		cwd,
		workspaceRoots,
		enabled: options.disabled !== true,
	};
	const skills = multi.skill;
	if (skills && skills.length > 0) input.skills = skills;

	const client = await resolveClient(context, argv);
	const created = await client.agents.create(input);
	if (options.json) {
		log(JSON.stringify(created, null, 2));
		return;
	}
	log(
		`已登记 agent placement ${created.id}：${created.agentId} → ${created.clientId}${created.enabled ? "" : "（已停用）"}`,
	);
}

async function resolveClientIdFor(
	context: AgentsCommandContext,
	argv: string[],
	filter: string,
): Promise<string> {
	if (context.resolveClientIdFn) return context.resolveClientIdFn(filter);
	const client = await resolveClient(context, argv);
	return resolveClientId(filter, context.paths, context.processEnv, client);
}
