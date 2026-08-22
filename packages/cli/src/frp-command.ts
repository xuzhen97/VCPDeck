import type { FrpsInstanceInfo } from "@vcpdeck/shared";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { resolveClientId } from "./client-resolver.js";
import type { ConfigPaths } from "./config.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";
import { formatTable } from "./table.js";

/** FRP 命令运行时依赖，测试可注入。 */
export interface FrpCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
}

/**
 * 实例信息的安全投影：authToken/dashboardPassword 等凭据绝不进入输出。
 */
function safeInstance(instance: FrpsInstanceInfo) {
	return {
		name: instance.name,
		server: `${instance.serverAddr}:${instance.serverPort}`,
		dashboard:
			instance.dashboardHost !== null
				? `${instance.dashboardScheme}://${instance.dashboardHost}:${instance.dashboardPort}`
				: "-",
		default: instance.isDefault ? "yes" : "-",
	};
}

/** 执行 FRP 命令组（当前只读）。 */
export async function runFrpCommand(
	subcommand: string | undefined,
	argv: string[],
	context: FrpCommandContext = {},
): Promise<void> {
	const helpRequested =
		subcommand === "--help" ||
		subcommand === "-h" ||
		((subcommand === "instances" ||
			subcommand === "mappings" ||
			subcommand === undefined) &&
			hasHelp(argv));
	if (helpRequested) {
		(context.log ?? console.log)(frpUsage());
		return;
	}
	if (subcommand === "instances") {
		await runInstances(argv, context);
		return;
	}
	if (subcommand === "mappings") {
		await runMappings(argv, context);
		return;
	}
	throw new Error(frpUsage());
}

function hasHelp(argv: string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

function frpUsage(): string {
	return [
		"FRP 命令（只读）:",
		"  vcpdeck frp instances [--page=<n>] [--env=<name>] [--json]",
		"  vcpdeck frp mappings [--client=<name|id>] [--page=<n>] [--env=<name>] [--json]",
	].join("\n");
}

async function runInstances(
	argv: string[],
	context: FrpCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "page"],
		boolean: ["json"],
	});
	if (positionals.length > 0) throw new Error(frpUsage());
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const client = await createAuthenticatedClient(environment);
	const result = await client.frp.instances.list({
		page: parsePage(stringOption(options, "page")),
	});
	if (options.json === true) {
		const safe = result.data.map(safeInstance);
		(context.log ?? console.log)(
			JSON.stringify({ ...result, data: safe }, null, 2),
		);
		return;
	}
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	log(
		`FRP 服务实例（${result.total}）：`,
	);
	log(
		formatTable(
			result.data.map(safeInstance),
			["name", "server", "dashboard", "default"],
		),
	);
}

async function runMappings(
	argv: string[],
	context: FrpCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "client", "page"],
		boolean: ["json"],
	});
	if (positionals.length > 0) throw new Error(frpUsage());
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const client = await createAuthenticatedClient(environment);
	const clientFilter = stringOption(options, "client");
	const clientId = clientFilter
		? await resolveClientId(clientFilter, context.paths, context.processEnv)
		: undefined;
	const result = await client.frp.list({
		clientId,
		page: parsePage(stringOption(options, "page")),
	});
	if (options.json === true) {
		(context.log ?? console.log)(JSON.stringify(result, null, 2));
		return;
	}
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	if (result.data.length === 0) {
		log("当前过滤条件下没有映射。");
		return;
	}
	log(`FRP 映射（共 ${result.total} · 第 ${result.page}/${result.totalPages} 页）：`);
	log(
		formatTable(
			result.data.map((mapping) => ({
				name: mapping.name,
				client: mapping.clientId,
				type: mapping.proxyType,
				local: `${mapping.localIp}:${mapping.localPort}`,
				remote: mapping.remotePort === null ? "-" : String(mapping.remotePort),
				status: mapping.status,
				url: mapping.publicUrl ?? "-",
			})),
			["name", "client", "type", "local", "remote", "status", "url"],
		),
	);
}

function exclusiveAlias(
	options: Record<string, string | true>,
	first: string,
	second: string,
): string | undefined {
	const firstValue = stringOption(options, first);
	const secondValue = stringOption(options, second);
	if (firstValue && secondValue) {
		throw new Error(`--${first} 与 --${second} 不能同时使用`);
	}
	return firstValue ?? secondValue;
}

function parsePage(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const page = Number(raw);
	if (!Number.isInteger(page) || page < 1) {
		throw new Error("--page 必须是不小于 1 的整数");
	}
	return page;
}
