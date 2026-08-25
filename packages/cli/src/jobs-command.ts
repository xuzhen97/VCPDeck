import type { JobInfo, PaginatedResult } from "@vcpdeck/shared";
import { JobStatus } from "@vcpdeck/shared";
import { VcpDeckApiError, type VcpDeckClient } from "@vcpdeck/sdk";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { resolveClientId } from "./client-resolver.js";
import type { ConfigPaths } from "./config.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";

/** Jobs 命令运行时依赖，测试可注入。 */
export interface JobsCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	error?: (message: string) => void;
	/** 终态轮询间隔；测试可缩短。 */
	pollIntervalMs?: number;
}

/** status 过滤允许的值：JobStatus 全集 + Server 支持的 active 聚合。 */
const STATUS_FILTERS = new Set<string>([...Object.values(JobStatus), "active"]);

const DEFAULT_WAIT_TIMEOUT_SECONDS = 1_800;
const POLL_INTERVAL_MS = 2_000;

/** 终态集合：disconnected 视为失败终态（目标机掉线，需人工确认后续）。 */
const TERMINAL_STATUSES = new Set<JobStatus>([
	JobStatus.DONE,
	JobStatus.ERROR,
	JobStatus.CANCELLED,
	JobStatus.DISCONNECTED,
]);

/** 执行 Jobs 命令组（list/get 只读；run/cancel 为写操作）。 */
export async function runJobsCommand(
	subcommand: string | undefined,
	argv: string[],
	context: JobsCommandContext = {},
): Promise<void> {
	const helpRequested =
		subcommand === "--help" ||
		subcommand === "-h" ||
		((subcommand === "list" ||
			subcommand === "get" ||
			subcommand === "run" ||
			subcommand === "cancel" ||
			subcommand === undefined) &&
			hasHelp(argv));
	if (helpRequested) {
		(context.log ?? console.log)(jobsUsage());
		return;
	}
	if (subcommand === "list") {
		await runListJobs(argv, context);
		return;
	}
	if (subcommand === "get") {
		await runGetJob(argv, context);
		return;
	}
	if (subcommand === "run") {
		await runExecJob(argv, context);
		return;
	}
	if (subcommand === "cancel") {
		await runCancelJob(argv, context);
		return;
	}
	throw new Error(jobsUsage());
}

function hasHelp(argv: string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

function jobsUsage(): string {
	return [
		"Jobs 命令:",
		"  vcpdeck jobs list [--client=<name|id>] [--status=<status>] [--page=<n>] [--env=<name>] [--json]",
		"  vcpdeck jobs get <jobId> [--env=<name>] [--json]  # 含失败现场（stdout/stderr spool）",
		"  vcpdeck jobs run <client> [--cwd=<dir>] [--timeout=<seconds>] [--wait] [--wait-timeout=<seconds>] [--env=<name>] [--json] -- <command...>",
		"  # 写操作：--timeout/--wait-timeout 单位为秒；复杂命令建议作为 -- 后的单一参数；确认门由调用方负责",
		"  vcpdeck jobs cancel <jobId> [--env=<name>] [--json]",
	].join("\n");
}

interface ListOptions {
	options: Record<string, string | true>;
	positionals: string[];
}

function parseListArgs(argv: string[]): ListOptions {
	return parseCommandArgs(argv, {
		value: ["env", "environment", "client", "status", "page"],
		boolean: ["json"],
	});
}

async function runListJobs(
	argv: string[],
	context: JobsCommandContext,
): Promise<void> {
	const { positionals, options } = parseListArgs(argv);
	if (positionals.length > 0) throw new Error(jobsUsage());
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const status = requireValidStatus(stringOption(options, "status"));
	const page = parsePage(stringOption(options, "page"));
	const clientFilter = stringOption(options, "client");
	const log = context.log ?? console.log;
	const client = await createAuthenticatedClient(environment);
	const clientId = clientFilter
		? await resolveClientId(clientFilter, context.paths, context.processEnv)
		: undefined;
	const result = await client.jobs.list({ clientId, status, page });
	if (options.json === true) {
		log(JSON.stringify(result, null, 2));
		return;
	}
	log(formatEnvironmentSummary(environment));
	log(formatJobsList(result));
}

async function runGetJob(
	argv: string[],
	context: JobsCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment"],
		boolean: ["json"],
	});
	if (positionals.length !== 1) throw new Error(jobsUsage());
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const log = context.log ?? console.log;
	const client = await createAuthenticatedClient(environment);
	const jobId = positionals[0];
	const job = await client.jobs.get(jobId);
	// 响应形状属于跨运行时协议，显式声明避免 CLI 类型检查耦合 SDK 构建产物的新鲜度
	const { output } = await client.request<{
		jobId: string;
		output: string | null;
	}>("GET", `/api/jobs/${encodeURIComponent(jobId)}/output`);
	if (options.json === true) {
		log(JSON.stringify({ ...job, output }, null, 2));
		return;
	}
	log(formatEnvironmentSummary(environment));
	log(formatJobDetail(job, output));
}

/** 在目标机上执行 shell 命令（写操作）；--wait 时等待终态并带出失败现场。 */
async function runExecJob(
	argv: string[],
	context: JobsCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "cwd", "timeout", "wait-timeout"],
		boolean: ["json", "wait"],
	});
	const [clientFilter, ...commandTokens] = positionals;
	if (!clientFilter || commandTokens.length === 0) {
		throw new Error(jobsUsage());
	}
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const timeout = parsePositiveSeconds(
		stringOption(options, "timeout"),
		"--timeout",
	);
	const waitTimeout =
		parsePositiveSeconds(
			stringOption(options, "wait-timeout"),
			"--wait-timeout",
		) ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
	const log = context.log ?? console.log;
	const error = context.error ?? console.error;
	const client = await createAuthenticatedClient(environment);
	const clientId = await resolveClientId(
		clientFilter,
		context.paths,
		context.processEnv,
	);

	// command 模式：token 以空格连接后由目标机 shell 执行（Windows 下自动 chcp 65001）
	const payload: Record<string, unknown> = {
		mode: "command",
		command: commandTokens.join(" "),
	};
	const cwd = stringOption(options, "cwd");
	if (cwd) payload.cwd = cwd;
	if (
		commandTokens.length > 1 &&
		commandTokens.some((token) => token.length === 0 || /\s/.test(token))
	) {
		error(
			"[vcpdeck] 注意：多个命令 token 以空格连接，含空白 token 的参数边界会丢失；建议把完整 shell 命令作为 -- 后的单一参数",
		);
	}

	if (options.json !== true) {
		log(formatEnvironmentSummary(environment));
		log(`[vcpdeck] 在 ${clientFilter} 上执行: ${payload.command as string}`);
	}
	const created = await client.jobs.create({
		clientId,
		type: "exec",
		payload,
		timeout: timeout === undefined ? undefined : timeout * 1_000,
	});

	if (options.wait !== true) {
		if (options.json === true) {
			log(JSON.stringify(created, null, 2));
		} else {
			log(
				`[vcpdeck] Job 已创建: ${created.jobId}（${created.status}）；用 jobs get ${created.jobId} 查询结果，或加 --wait 直接等待终态`,
			);
		}
		return;
	}

	const job = await waitForTerminalJob(
		client,
		created.jobId,
		waitTimeout,
		options.json === true ? error : log,
		context.pollIntervalMs ?? POLL_INTERVAL_MS,
	);
	// 成功与失败都取回输出；失败时非零退出并展示完整现场（闭环）
	const output = await readJobOutputText(client, job.jobId).catch(() => null);
	if (options.json === true) {
		log(JSON.stringify({ ...job, output }, null, 2));
	}
	if (job.status !== JobStatus.DONE) {
		if (options.json !== true) log(formatJobDetail(job, output));
		throw new Error(`Job ${job.jobId} 终态为 ${job.status}`);
	}
	if (options.json !== true) log(formatJobDetail(job, output));
}

/** 轮询 Job 直到终态或超时；仅重试安全 GET，容忍 Server 重启短暂不可达。 */
export async function waitForTerminalJob(
	client: VcpDeckClient,
	jobId: string,
	timeoutSeconds: number,
	log: (message: string) => void,
	pollIntervalMs: number,
): Promise<JobInfo> {
	const deadline = Date.now() + timeoutSeconds * 1_000;
	let lastStatus: string | undefined;
	while (Date.now() < deadline) {
		try {
			const job = await client.jobs.get(jobId);
			if (TERMINAL_STATUSES.has(job.status)) return job;
			if (job.status !== lastStatus) {
				log(`[vcpdeck] Job ${jobId} 状态: ${job.status}`);
				lastStatus = job.status;
			}
		} catch (error) {
			if (!isTransientReadError(error)) throw error;
			log("[vcpdeck] Server 暂时不可达，继续等待…");
		}
		await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
	}
	throw new Error(
		`等待 Job ${jobId} 终态超时（${timeoutSeconds} 秒）；用 jobs get ${jobId} 查询当前状态`,
	);
}

/** 读取输出 spool 正文；响应形状属于跨运行时协议，显式声明。 */
async function readJobOutputText(
	client: VcpDeckClient,
	jobId: string,
): Promise<string | null> {
	const { output } = await client.request<{
		jobId: string;
		output: string | null;
	}>("GET", `/api/jobs/${encodeURIComponent(jobId)}/output`);
	return output;
}

/** 取消 Job（写操作）：pending 立即 cancelled；running 返回 cancelling 待 Client 确认。 */
async function runCancelJob(
	argv: string[],
	context: JobsCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment"],
		boolean: ["json"],
	});
	if (positionals.length !== 1) throw new Error(jobsUsage());
	const environment = await resolveEnvironment({
		environment: exclusiveAlias(options, "env", "environment"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	const log = context.log ?? console.log;
	const client = await createAuthenticatedClient(environment);
	const result = await client.jobs.cancel(positionals[0]);
	if (options.json === true) {
		log(JSON.stringify(result, null, 2));
		return;
	}
	log(formatEnvironmentSummary(environment));
	log(
		`[vcpdeck] Job ${result.jobId} 取消请求已提交，当前状态: ${result.status}${result.status === "cancelling" ? "（等待 Client 确认，终态用 jobs get 核对）" : ""}`,
	);
}

/** 人类可读的 Job 列表：进行中优先，其余按创建时间倒序展示分页页内容。 */
function formatJobsList(result: PaginatedResult<JobInfo>): string {
	const sorted = [...result.data].sort((a, b) => {
		const active = (job: JobInfo) =>
			job.status === JobStatus.RUNNING ||
			job.status === JobStatus.PENDING ||
			job.status === JobStatus.WAITING_INPUT
				? 0
				: 1;
		const byActive = active(a) - active(b);
		if (byActive !== 0) return byActive;
		return b.createdAt.localeCompare(a.createdAt);
	});
	const rows = sorted.map((job) => ({
		jobId: job.jobId,
		client: job.clientName ?? job.clientId,
		type: job.type,
		status: job.status,
		error: job.errorCode ?? "-",
		created: job.createdAt,
	}));
	const body =
		rows.length === 0
			? ["当前过滤条件下没有 Job。"]
			: [
					formatTable(rows, [
						"jobId",
						"client",
						"type",
						"status",
						"error",
						"created",
					]),
				];
	return [
		`共 ${result.total} 条 · 第 ${result.page}/${result.totalPages} 页`,
		...body,
	].join("\n");
}

/** 人类可读的 Job 详情：含错误摘要与完整输出 spool（失败现场）。 */
function formatJobDetail(job: JobInfo, output: string | null): string {
	const lines = [
		`Job: ${job.jobId}`,
		`Client: ${job.clientName ?? job.clientId}`,
		`Type: ${job.type}`,
		`Status: ${job.status}`,
	];
	if (job.errorCode || job.errorMessage) {
		lines.push(
			`Error: ${job.errorCode ?? "-"}${job.errorMessage ? ` — ${job.errorMessage}` : ""}`,
		);
	}
	if (job.timeout != null) lines.push(`Timeout: ${job.timeout} ms`);
	lines.push(`Created: ${job.createdAt}`);
	if (job.startedAt) lines.push(`Started: ${job.startedAt}`);
	if (job.finishedAt) lines.push(`Finished: ${job.finishedAt}`);
	if (job.createdByName || job.createdVia) {
		lines.push(`Creator: ${job.createdByName ?? "-"} (${job.createdVia ?? "-"})`);
	}
	if (job.result && Object.keys(job.result).length > 0) {
		lines.push(`Result: ${JSON.stringify(job.result)}`);
	}
	if (output === null) {
		lines.push("（无落盘输出）");
	} else {
		lines.push("── 输出（stdout/stderr）──", output.trimEnd());
	}
	return lines.join("\n");
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

function requireValidStatus(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (!STATUS_FILTERS.has(raw)) {
		throw new Error(`--status 必须是 ${[...STATUS_FILTERS].join("/")} 之一`);
	}
	return raw;
}

function parsePage(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const page = Number(raw);
	if (!Number.isInteger(page) || page < 1) {
		throw new Error("--page 必须是不小于 1 的整数");
	}
	return page;
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

function isTransientReadError(error: unknown): boolean {
	if (error instanceof VcpDeckApiError) {
		return error.status === 0 || [502, 503, 504].includes(error.status);
	}
	return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
