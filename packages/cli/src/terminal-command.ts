import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { resolveClientId } from "./client-resolver.js";
import type { ConfigPaths } from "./config.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";
import { formatTable } from "./table.js";

/** Terminal 命令运行时依赖，测试可注入。 */
export interface TerminalCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
}

/** 执行 Terminal 命令组：shells/list 只读；close 写操作。 */
export async function runTerminalCommand(
	subcommand: string | undefined,
	argv: string[],
	context: TerminalCommandContext = {},
): Promise<void> {
	const helpRequested =
		subcommand === "--help" ||
		subcommand === "-h" ||
		((subcommand === "shells" ||
			subcommand === "list" ||
			subcommand === "close" ||
			subcommand === undefined) &&
			hasHelp(argv));
	if (helpRequested) {
		(context.log ?? console.log)(terminalUsage());
		return;
	}
	if (subcommand === "shells") {
		await runShells(argv, context);
		return;
	}
	if (subcommand === "list") {
		await runList(argv, context);
		return;
	}
	if (subcommand === "close") {
		await runClose(argv, context);
		return;
	}
	throw new Error(terminalUsage());
}

function hasHelp(argv: string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

function terminalUsage(): string {
	return [
		"Terminal 命令:",
		"  vcpdeck terminal shells <client> [--env=<name>] [--json]",
		"  vcpdeck terminal list <client> [--status=<status>] [--env=<name>] [--json]",
		"  vcpdeck terminal close <client> <sessionId> [--env=<name>] [--json]  # 写操作，会话将被终止",
		"  # 交互式 PTY 输入输出在 Frontend（Socket.IO），CLI 仅管理生命周期",
	].join("\n");
}

/** 解析环境并创建已认证客户端；terminal 无 --environment 别名需求。 */
async function openContext(
	context: TerminalCommandContext,
	options: Record<string, string | true>,
) {
	const environment = await resolveEnvironment({
		environment: stringOption(options, "env"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const client = await createAuthenticatedClient(environment);
	return { environment, client };
}

async function runShells(
	argv: string[],
	context: TerminalCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment"],
		boolean: ["json"],
	});
	const [clientFilter] = positionals;
	if (!clientFilter || positionals.length > 1) throw new Error(terminalUsage());
	const { environment, client } = await openContext(context, options);
	const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
	const shells = await client.terminals.shells(clientId);
	if (options.json === true) {
		(context.log ?? console.log)(JSON.stringify(shells, null, 2));
		return;
	}
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	log(`可用 Shell（${shells.length}）：`);
	log(
		formatTable(
			shells.map((shell) => ({
				id: shell.id,
				label: shell.label,
				kind: shell.kind,
				default: shell.isDefault ? "yes" : "-",
			})),
			["id", "label", "kind", "default"],
		),
	);
}

async function runList(
	argv: string[],
	context: TerminalCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "status"],
		boolean: ["json"],
	});
	const [clientFilter] = positionals;
	if (!clientFilter || positionals.length > 1) throw new Error(terminalUsage());
	const { environment, client } = await openContext(context, options);
	const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
	// SDK 列表为分页 API；--status 为本地过滤（首页内），非服务端协议参数
	const result = await client.terminals.list(clientId, { pageSize: 100 });
	const statusFilter = stringOption(options, "status")?.toLowerCase();
	const sessions = statusFilter
		? result.data.filter((s) => s.status.toLowerCase() === statusFilter)
		: result.data;
	if (options.json === true) {
		(context.log ?? console.log)(JSON.stringify(sessions, null, 2));
		return;
	}
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	if (sessions.length === 0) {
		log("当前过滤条件下没有终端会话。");
		return;
	}
	log(`终端会话（${sessions.length}）：`);
	log(
		formatTable(
			sessions.map((session) => ({
				sessionId: session.sessionId,
				shell: session.shellLabel,
				status: session.status,
				creator: session.createdByName ?? "-",
				created: session.createdAt,
				endReason: session.endReason ?? "-",
			})),
			["sessionId", "shell", "status", "creator", "created", "endReason"],
		),
	);
}

/** 关闭终端会话（写操作）：PTY 与会话状态将被终止。 */
async function runClose(
	argv: string[],
	context: TerminalCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment"],
		boolean: ["json"],
	});
	const [clientFilter, sessionId] = positionals;
	if (!clientFilter || !sessionId || positionals.length > 2) {
		throw new Error(terminalUsage());
	}
	const { environment, client } = await openContext(context, options);
	const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
	const session = (await client.terminals.get(clientId, sessionId)) as {
		shellLabel?: string;
		createdByName?: string | null;
	};
	const log = context.log ?? console.log;
	if (options.json !== true) log(formatEnvironmentSummary(environment));
	log(
		`[vcpdeck] 关闭 ${clientFilter} 的终端会话 ${sessionId}${session?.shellLabel ? `（${session.shellLabel}${session.createdByName ? `，创建者 ${session.createdByName}` : ""}）` : ""}`,
	);
	await client.terminals.remove(clientId, sessionId);
	if (options.json === true) {
		log(JSON.stringify({ sessionId, closed: true }, null, 2));
		return;
	}
	log(`[vcpdeck] 终端会话 ${sessionId} 已关闭`);
}
