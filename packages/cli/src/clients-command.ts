import { selectLatestCatchUpTarget, type ClientInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import type { ConfigPaths } from "./config.js";
import {
	formatEnvironmentSummary,
	resolveEnvironment,
} from "./environment.js";
import { formatPrivilegeSummary } from "./privileged-capability.js";

/** Clients 命令运行时依赖，测试可注入。 */
export interface ClientsCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
}

/** 执行 Clients 命令组（当前只读）。 */
export async function runClientsCommand(
	subcommand: string | undefined,
	argv: string[],
	context: ClientsCommandContext = {},
): Promise<void> {
	const helpRequested =
		subcommand === "--help" ||
		subcommand === "-h" ||
		((subcommand === "list" || subcommand === undefined) && hasHelp(argv));
	if (helpRequested) {
		(context.log ?? console.log)(clientsUsage());
		return;
	}
	if (subcommand === "list") {
		await runListClients(argv, context);
		return;
	}
	throw new Error(clientsUsage());
}

function hasHelp(argv: string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

function clientsUsage(): string {
	return [
		"Clients 命令:",
		"  vcpdeck clients list [--env=<name>] [--json]",
	].join("\n");
}

async function runListClients(
	argv: string[],
	context: ClientsCommandContext,
): Promise<void> {
	const { options } = parseCommandArgs(argv, {
		value: ["env", "environment"],
		boolean: ["json"],
	});
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const log = context.log ?? console.log;
	if (options.json === true) {
		const client = await createAuthenticatedClient(environment);
		const clients = await client.clients.list();
		log(JSON.stringify(clients, null, 2));
		return;
	}
	log(formatEnvironmentSummary(environment));
	const client = await createAuthenticatedClient(environment);
	const clients = await client.clients.list();
	log(formatClientsSummary(clients, await readCatchUpTargetVersion(client)));
}

/** 把操作者注解压缩成单行网络摘要；保持 JSON 为完整事实来源。 */
function formatNetworkAnnotation(
	annotations: ClientInfo["annotations"],
): string {
	if (!annotations) return "未补充";
	const publicAddress = annotations.publicAddress;
	if (publicAddress === null) return "未声明";
	const values = [...publicAddress.v4, ...publicAddress.v6];
	if (publicAddress.host) values.push(publicAddress.host);
	return values.length === 0 ? "无公网" : values.join(",");
}

/** 生成人类可读的机器列表；在线优先，其余按名称稳定排序。 */
function formatClientsSummary(
	clients: ClientInfo[],
	targetVersion: string | null = null,
): string {
	if (clients.length === 0) return "没有已注册的 Client。";
	const sorted = [...clients].sort((a, b) => {
		if (a.online !== b.online) return a.online ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const rows = sorted.map((client) => ({
		name: client.name,
		hostname: client.hostname,
		os: client.os,
		state: client.online ? "online" : "offline",
		cpu: formatPercent(client.cpuPercent),
		mem: formatPercent(client.memPercent),
		version: client.clientVersion,
		// 落后判定以服务端上报的 clientVersion 与当前补更目标比对，不做本地推断
		outdated:
			targetVersion === null
				? "—"
				: client.clientVersion === targetVersion
					? "no"
					: "yes",
		privilege: formatPrivilegeSummary(client),
		network: formatNetworkAnnotation(client.annotations),
	}));
	const onlineCount = clients.filter((client) => client.online).length;
	const header =
		targetVersion === null
			? `共 ${clients.length} 台 · 在线 ${onlineCount} · 离线 ${clients.length - onlineCount} · 当前无补更目标`
			: `共 ${clients.length} 台 · 在线 ${onlineCount} · 离线 ${clients.length - onlineCount} · 补更目标 ${targetVersion}`;
	return [
		header,
		formatTable(rows, [
			"name",
			"hostname",
			"os",
			"state",
			"cpu",
			"mem",
			"version",
			"outdated",
			"privilege",
			"network",
		]),
	].join("\n");
}

/** 读取当前补更目标版本；无目标或读取失败时返回 null，不影响列表输出。 */
async function readCatchUpTargetVersion(
	client: VcpDeckClient,
): Promise<string | null> {
	try {
		const result = await client.releases.list({ page: 1, pageSize: 100 });
		return selectLatestCatchUpTarget(result.data)?.version ?? null;
	} catch {
		return null;
	}
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

function formatPercent(value: number | null): string {
	return value === null ? "-" : `${value.toFixed(0)}%`;
}

interface TableRow extends Record<string, string> {}

/** 无依赖的简易对齐表格；首行为表头。 */
function formatTable(rows: TableRow[], columns: string[]): string {
	const widths = columns.map((column) =>
		Math.max(column.length, ...rows.map((row) => row[column].length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, index) => cell.padEnd(widths[index]))
			.join("  ")
			.trimEnd();
	return [
		line(columns.map((column) => column.toUpperCase())),
		...rows.map((row) => line(columns.map((column) => row[column]))),
	].join("\n");
}
