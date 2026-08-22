import { randomUUID } from "node:crypto";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { fetchClientRoots, resolveClientId } from "./client-resolver.js";
import type { ConfigPaths } from "./config.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";

/** Pi 命令运行时依赖，测试可注入。 */
export interface PiCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	/** 运行状态轮询间隔；测试可缩短。 */
	pollIntervalMs?: number;
}

const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
const POLL_INTERVAL_MS = 3_000;

interface CwdRef {
	rootDir: string;
	relativePath: string;
}

/** 执行 Pi 命令组（models/sessions/new 只读；run/abort 驱动远端 Agent）。 */
export async function runPiCommand(
	subcommand: string | undefined,
	argv: string[],
	context: PiCommandContext = {},
): Promise<void> {
	const helpRequested =
		subcommand === "--help" ||
		subcommand === "-h" ||
		((subcommand === "models" ||
			subcommand === "sessions" ||
			subcommand === "new" ||
			subcommand === "run" ||
			subcommand === "abort" ||
			subcommand === undefined) &&
			hasHelp(argv));
	if (helpRequested) {
		(context.log ?? console.log)(piUsage());
		return;
	}
	if (subcommand === "models") {
		await runModels(argv, context);
		return;
	}
	if (subcommand === "sessions") {
		await runSessions(argv, context);
		return;
	}
	if (subcommand === "new") {
		await runNew(argv, context);
		return;
	}
	if (subcommand === "run") {
		await runRun(argv, context);
		return;
	}
	if (subcommand === "abort") {
		await runAbort(argv, context);
		return;
	}
	throw new Error(piUsage());
}

function hasHelp(argv: string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

function piUsage(): string {
	return [
		"Pi 命令:",
		"  vcpdeck pi models <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck pi sessions <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck pi new <client> --cwd=<path> [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck pi run <client> \"提示词\" --cwd=<path> [--session=<id>] [--root=<dir>] [--timeout=<seconds>] [--env=<name>] [--json]",
		"  # 写操作：在目标机驱动 AI Agent 执行任务；调用方须先取得用户明确确认",
		"  vcpdeck pi abort <client> --session=<id> [--env=<name>] [--json]",
		"  # 缺省 --root 时自动探测：唯一根直接使用，多根要求显式指定",
	].join("\n");
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

async function openContext(
	context: PiCommandContext,
	options: Record<string, string | true>,
) {
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const client = await createAuthenticatedClient(environment);
	return { environment, client };
}

async function resolveClientIdOrThrow(
	clientFilter: string,
	context: PiCommandContext,
): Promise<string> {
	return resolveClientId(clientFilter, context.paths, context.processEnv);
}

/** 解析 cwdRef：--root 显式或自动探测唯一根；--cwd 为相对路径（缺省 .）。 */
async function resolveCwdRef(
	client: VcpDeckClient,
	clientId: string,
	options: Record<string, string | true>,
	context: PiCommandContext,
): Promise<CwdRef> {
	const explicitRoot = stringOption(options, "root");
	let rootDir = explicitRoot;
	if (!rootDir) {
		const roots = await fetchClientRoots(client, clientId);
		if (roots.length === 1) rootDir = roots[0];
		else if (roots.length === 0)
			throw new Error("目标机未报告可用根目录（或 Pi capability 缺失）");
		else
			throw new Error(
				`目标机有多个可用根（${roots.join("、")}）；请用 --root=<dir> 指定授权根`,
			);
	}
	return { rootDir, relativePath: stringOption(options, "cwd") ?? "." };
}

async function runModels(
	argv: string[],
	context: PiCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "root", "cwd"],
		boolean: ["json"],
	});
	const [clientFilter] = positionals;
	if (!clientFilter || positionals.length > 1) throw new Error(piUsage());
	const { environment, client } = await openContext(context, options);
	const clientId = await resolveClientIdOrThrow(clientFilter, context);
	const cwdRef = await resolveCwdRef(client, clientId, options, context);
	const models = await client.pi.models(clientId, cwdRef);
	if (options.json === true) {
		(context.log ?? console.log)(JSON.stringify(models, null, 2));
		return;
	}
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	log(`可用模型（${models.length}）：`);
	for (const model of models) log(`  ${model.provider}/${model.modelId}`);
}

interface SessionSummaryShape {
	sessionId?: string;
	name?: string;
}

async function runSessions(
	argv: string[],
	context: PiCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "root", "cwd"],
		boolean: ["json"],
	});
	const [clientFilter] = positionals;
	if (!clientFilter || positionals.length > 1) throw new Error(piUsage());
	const { environment, client } = await openContext(context, options);
	const clientId = await resolveClientIdOrThrow(clientFilter, context);
	const cwdRef = await resolveCwdRef(client, clientId, options, context);
	const sessions = await client.pi.sessions.list(clientId, cwdRef);
	if (options.json === true) {
		(context.log ?? console.log)(JSON.stringify(sessions, null, 2));
		return;
	}
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	if (!Array.isArray(sessions)) {
		log(JSON.stringify(sessions, null, 2));
		return;
	}
	log(`会话（${sessions.length}）：`);
	for (const item of sessions as SessionSummaryShape[]) {
		log(`  ${item.sessionId ?? "?"}  ${item.name ?? ""}`);
	}
}

async function runNew(argv: string[], context: PiCommandContext): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "root", "cwd"],
		boolean: ["json"],
	});
	const [clientFilter] = positionals;
	if (!clientFilter || positionals.length > 1) throw new Error(piUsage());
	const { environment, client } = await openContext(context, options);
	const clientId = await resolveClientIdOrThrow(clientFilter, context);
	const cwdRef = await resolveCwdRef(client, clientId, options, context);
	const created = await client.pi.agent.newSession(clientId, cwdRef);
	if (options.json === true) {
		(context.log ?? console.log)(JSON.stringify(created, null, 2));
		return;
	}
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	log(`[vcpdeck] 新会话已创建: ${created.sessionId}`);
}

interface AssistantMessageShape {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
}

interface ContextPageShape {
	messages?: Array<Record<string, unknown>>;
}

/** 从 context 页提取最后一条 assistant 消息的文本内容。 */
function extractLastAssistantText(
	page: ContextPageShape | undefined,
): string | null {
	const messages = Array.isArray(page?.messages) ? page.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as AssistantMessageShape | undefined;
		if (message?.role !== "assistant") continue;
		const text = (message.content ?? [])
			.filter((part) => part?.type === "text")
			.map((part) => part.text ?? "")
			.join("\n")
			.trim();
		return text.length > 0 ? text : null;
	}
	return null;
}

/** 在目标机 Pi 上执行子任务（最强确认门写操作）：prompt → 等待 idle → 取回复。 */
async function runRun(argv: string[], context: PiCommandContext): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "root", "cwd", "session", "timeout"],
		boolean: ["json"],
	});
	const [clientFilter, ...promptTokens] = positionals;
	const prompt = promptTokens.join(" ");
	if (!clientFilter || !prompt) throw new Error(piUsage());
	const timeout = parsePositiveSeconds(
		stringOption(options, "timeout"),
		"--timeout",
	);
	const waitTimeout = timeout ?? DEFAULT_RUN_TIMEOUT_SECONDS;
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const client = await createAuthenticatedClient(environment);
	const clientId = await resolveClientIdOrThrow(clientFilter, context);
	const cwdRef = await resolveCwdRef(client, clientId, options, context);
	const log = context.log ?? console.log;
	const progressLog = options.json === true ? () => {} : log;
	if (options.json !== true) {
		log(formatEnvironmentSummary(environment));
		log(
			`[vcpdeck] Pi 子任务 → ${clientFilter}:${cwdRef.relativePath}（${waitTimeout}s 超时）`,
		);
		log(`[vcpdeck] 提示词: ${prompt}`);
	}

	const existingSession = stringOption(options, "session");
	let sessionId: string;
	if (existingSession) {
		sessionId = existingSession;
		await client.pi.agent.open(clientId, sessionId, cwdRef);
		progressLog(`[vcpdeck] 已打开既有会话 ${sessionId}`);
	} else {
		const created = await client.pi.agent.newSession(clientId, cwdRef);
		sessionId = created.sessionId;
		progressLog(`[vcpdeck] 已创建新会话 ${sessionId}`);
	}

	await client.pi.agent.prompt(clientId, sessionId, cwdRef, {
		submissionId: randomUUID(),
		prompt,
	});
	progressLog("[vcpdeck] 提示词已提交，等待 Pi 完成…");

	const deadline = Date.now() + waitTimeout * 1_000;
	let lastStatus: string | undefined;
	while (Date.now() < deadline) {
		const state = (await client.pi.agent.state(
			clientId,
			sessionId,
			cwdRef,
		)) as { status?: string };
		const status = typeof state?.status === "string" ? state.status : "unknown";
		if (status === "idle") break;
		if (status !== lastStatus) {
			progressLog(`[vcpdeck] Pi 状态: ${status}`);
			lastStatus = status;
		}
		if (status === "waiting_for_extension_input") {
			throw new Error(
				`Pi 正在等待扩展输入（会话 ${sessionId}）；请在 Frontend 处理后重试，或用 pi abort 中止`,
			);
		}
		await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
	}

	const page = (await client.pi.sessions.context(
		clientId,
		sessionId,
		cwdRef,
	)) as ContextPageShape;
	const reply = extractLastAssistantText(page);
	if (options.json === true) {
		log(
			JSON.stringify(
				{ sessionId, prompt, reply, messages: page?.messages ?? [] },
				null,
				2,
			),
		);
	} else if (reply !== null) {
		log(`── Pi 回复 ──\n${reply}`);
	} else {
		log("（未取到助手文本回复；用 --json 查看完整上下文）");
	}
}

async function runAbort(
	argv: string[],
	context: PiCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "session"],
		boolean: ["json"],
	});
	const [clientFilter] = positionals;
	const sessionId = stringOption(options, "session");
	if (!clientFilter || !sessionId) throw new Error(piUsage());
	const { environment, client } = await openContext(context, options);
	const clientId = await resolveClientIdOrThrow(clientFilter, context);
	const result = await client.pi.agent.abort(clientId, sessionId, sessionId);
	if (options.json === true) {
		(context.log ?? console.log)(JSON.stringify(result, null, 2));
		return;
	}
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	log(`[vcpdeck] 会话 ${sessionId} 中止请求已提交`);
}

function parsePositiveSeconds(
	raw: string | undefined,
	flag: string,
): number | undefined {
	if (raw === undefined) return undefined;
	const seconds = Number(raw);
	if (!Number.isInteger(seconds) || seconds < 1) {
		throw new Error(`${flag} 必须是不小于 1 的整数秒`);
	}
	return seconds;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
