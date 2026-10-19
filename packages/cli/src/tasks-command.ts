/**
 * `vcpdeck tasks` 命令组（ADR-0057）。
 *
 * Task 是 A2A 任务契约，不是 Job；CLI 只通过 SDK 调 JSON-RPC，不直接读库。
 */
import type { A2aTask } from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { createAuthenticatedClient } from "./authenticated-client.js";
import type { ConfigPaths } from "./config.js";
import { resolveEnvironment } from "./environment.js";
import { envOverrideOf } from "./features-command.js";
import { formatTable } from "./table.js";

export interface TasksCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	error?: (message: string) => void;
	sdk?: VcpDeckClient;
}

const VALUE_OPTIONS = [
	"agent",
	"intent",
	"accept",
	"message",
	"task",
	"request",
	"option",
	"since",
	"limit",
	"page-size",
	"env",
	"environment",
] as const;

export async function runTasksCommand(
	subcommand: string | undefined,
	argv: string[],
	context: TasksCommandContext = {},
): Promise<void> {
	const log = context.log ?? console.log;
	if (
		subcommand === undefined ||
		subcommand === "--help" ||
		subcommand === "-h"
	) {
		log(tasksUsage());
		return;
	}
	const client =
		context.sdk ??
		(await createAuthenticatedClient(
			await resolveEnvironment({
				environment: envOverrideOf(argv),
				paths: context.paths,
				processEnv: context.processEnv,
			}),
		));
	if (subcommand === "send") {
		await runSend(argv, client, log);
		return;
	}
	if (subcommand === "get") {
		await runGet(argv, client, log);
		return;
	}
	if (subcommand === "list") {
		await runList(argv, client, log);
		return;
	}
	if (subcommand === "cancel") {
		await runCancel(argv, client, log);
		return;
	}
	if (subcommand === "answer") {
		await runAnswer(argv, client, log);
		return;
	}
	if (subcommand === "events") {
		await runEvents(argv, client, log);
		return;
	}
	throw new Error(tasksUsage());
}

function tasksUsage(): string {
	return [
		"Tasks 命令（A2A v1.0）:",
		"  vcpdeck tasks send --agent=<id> --intent=<text> --message=<text> [--accept=<a,b>] [--env=<name>] [--json]",
		"  vcpdeck tasks get <taskId> [--env=<name>] [--json]",
		"  vcpdeck tasks list [--page-size=<n>] [--env=<name>] [--json]",
		"  vcpdeck tasks cancel <taskId> [--env=<name>] [--json]",
		"  vcpdeck tasks answer <taskId> --request=<id> --option=<id> [--message=<text>] [--json]",
		"  vcpdeck tasks events <taskId> [--since=<seq>] [--limit=<n>] [--json]",
		"  agents: vcpdeck agents list|create [--env=<name>] [--json]",
	].join("\n");
}

function parse(
	argv: string[],
	positionalsNeeded: number,
): ReturnType<typeof parseCommandArgs> {
	const parsed = parseCommandArgs(argv, {
		value: [...VALUE_OPTIONS],
		boolean: ["json"],
	});
	if (parsed.positionals.length < positionalsNeeded) {
		throw new Error(tasksUsage());
	}
	return parsed;
}

async function runSend(
	argv: string[],
	client: VcpDeckClient,
	log: (message: string) => void,
): Promise<void> {
	const { options } = parse(argv, 0);
	const agent = stringOption(options, "agent");
	const intent = stringOption(options, "intent");
	const text = stringOption(options, "message");
	if (!agent || !intent || !text) throw new Error(tasksUsage());
	const task = await client.tasks.sendMessage({
		message: { messageId: `cli-${Date.now()}`, role: "user", parts: [{ text }] },
		metadata: {
			agentId: agent,
			intent,
			...(stringOption(options, "accept")
				? {
						acceptanceCriteria: splitList(
							stringOption(options, "accept") as string,
						),
					}
				: {}),
		},
	});
	printTask(task, options, log);
}

async function runGet(
	argv: string[],
	client: VcpDeckClient,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parse(argv, 1);
	const task = await client.tasks.get(positionals[0] as string);
	printTask(task, options, log);
}

async function runList(
	argv: string[],
	client: VcpDeckClient,
	log: (message: string) => void,
): Promise<void> {
	const { options } = parse(argv, 0);
	const pageSize = Number(stringOption(options, "page-size") ?? 20);
	const result = await client.tasks.list({ pageSize });
	if (options.json) {
		log(JSON.stringify(result, null, 2));
		return;
	}
	const rows = result.tasks.map((task) => ({
		id: task.id,
		state: task.status.state,
		updated: task.metadata?.vcpdeck?.updatedAt ?? "",
	}));
	log(formatTable(rows, ["id", "state", "updated"]));
}

async function runCancel(
	argv: string[],
	client: VcpDeckClient,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parse(argv, 1);
	const task = await client.tasks.cancel(positionals[0] as string);
	printTask(task, options, log);
}

async function runAnswer(
	argv: string[],
	client: VcpDeckClient,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parse(argv, 1);
	const taskId = positionals[0] as string;
	const requestId = stringOption(options, "request");
	const optionId = stringOption(options, "option");
	if (!requestId || !optionId) throw new Error(tasksUsage());
	const task = await client.tasks.sendMessage({
		message: {
			messageId: `cli-permission-${Date.now()}`,
			role: "user",
			taskId,
			parts: [{ text: stringOption(options, "message") ?? "permission decision" }],
		},
		metadata: {
			extensions: {
				"https://vcpdeck.dev/a2a/extensions/acp-permission/v1": {
					requestId,
					optionId,
				},
			},
		},
	});
	printTask(task, options, log);
}

async function runEvents(
	argv: string[],
	client: VcpDeckClient,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parse(argv, 1);
	const sinceRaw = stringOption(options, "since");
	const limitRaw = stringOption(options, "limit");
	const result = await client.tasks.events(positionals[0] as string, {
		...(sinceRaw ? { since: Number(sinceRaw) } : {}),
		...(limitRaw ? { limit: Number(limitRaw) } : {}),
	});
	if (options.json) {
		log(JSON.stringify(result, null, 2));
		return;
	}
	const rows = result.data.map((event) => ({
		seq: String(event.id),
		event: event.event,
		fidelity: event.fidelity,
		at: event.at,
	}));
	log(formatTable(rows, ["seq", "event", "fidelity", "at"]));
}

function printTask(
	task: A2aTask,
	options: Record<string, string | true>,
	log: (message: string) => void,
): void {
	if (options.json) {
		log(JSON.stringify(task, null, 2));
		return;
	}
	log(`${task.id}\t${task.status.state}`);
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}
