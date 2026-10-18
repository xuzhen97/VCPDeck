/**
 * `vcpdeck features` 命令组（ADR-0056）。
 *
 * 条目是声明 + 契约；有效性由验证产生。`active` 不提供写入入口：
 * 验证由本 CLI 执行（command 型走 exec Job，http 型 CLI 直连），Server 只记账。
 */
import { readFile } from "node:fs/promises";
import {
	JobStatus,
	type FeatureInfo,
	type FeatureInvocation,
	parseFeatureInputs,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { resolveClientId } from "./client-resolver.js";
import type { ConfigPaths } from "./config.js";
import type { ResolvedEnvironment } from "./environment.js";
import { resolveEnvironment } from "./environment.js";
import { waitForTerminalJob } from "./jobs-command.js";
import { formatTable } from "./table.js";

/** features 命令运行时依赖；测试可注入 SDK 与选择器。 */
export interface FeaturesCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	error?: (message: string) => void;
	/** 终态轮询间隔；测试可缩短。 */
	pollIntervalMs?: number;
	/** 测试注入：已认证 SDK 客户端。 */
	sdk?: VcpDeckClient;
	/** 测试注入：机器名/ID 解析。 */
	resolveClientIdFn?: (filter: string) => Promise<string>;
	/** 测试注入：环境解析（用于断言 --env 被透传）。 */
	resolveEnvironmentFn?: typeof resolveEnvironment;
	/** 测试注入：按环境创建客户端。 */
	createClientFn?: (environment: ResolvedEnvironment) => Promise<VcpDeckClient>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * 预解析 `--env`/`--environment`。
 *
 * 客户端必须在子命令解析前创建，否则 `--env` 会被忽略而落到默认环境。
 */
export function envOverrideOf(argv: string[]): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") break;
		if (arg.startsWith("--env=")) return arg.slice("--env=".length) || undefined;
		if (arg.startsWith("--environment=")) {
			return arg.slice("--environment=".length) || undefined;
		}
		if (arg === "--env" || arg === "--environment") return argv[index + 1];
	}
	return undefined;
}

/** 执行 Features 命令组。 */
export async function runFeaturesCommand(
	subcommand: string | undefined,
	argv: string[],
	context: FeaturesCommandContext = {},
): Promise<void> {
	const log = context.log ?? console.log;
	if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
		log(featuresUsage());
		return;
	}
	const resolveEnvironmentFn = context.resolveEnvironmentFn ?? resolveEnvironment;
	const createClientFn = context.createClientFn ?? createAuthenticatedClient;
	const client =
		context.sdk ??
		(await createClientFn(
			await resolveEnvironmentFn({
				environment: envOverrideOf(argv),
				paths: context.paths,
				processEnv: context.processEnv,
			}),
		));
	const resolveId =
		context.resolveClientIdFn ??
		((filter: string) =>
			resolveClientId(filter, context.paths, context.processEnv, client));

	if (subcommand === "list") {
		await runListFeatures(argv, client, resolveId, log);
		return;
	}
	if (subcommand === "get") {
		await runGetFeature(argv, client, resolveId, log);
		return;
	}
	if (subcommand === "add") {
		await runAddFeature(argv, client, resolveId, context, log);
		return;
	}
	if (subcommand === "verify") {
		await runVerifyFeature(argv, client, resolveId, context, log);
		return;
	}
	if (subcommand === "update") {
		await runUpdateFeature(argv, client, resolveId, log);
		return;
	}
	throw new Error(featuresUsage());
}

function featuresUsage(): string {
	return [
		"Features 命令:",
		"  vcpdeck features list [--client=<name|id>] [--scope=generic|machine] [--status=draft|active|retired] [--include-retired] [--env=<name>] [--json]",
		"  vcpdeck features get <slug|id> [--client=<name|id>] [--env=<name>] [--json]",
		"  vcpdeck features add --client=<name|id> --slug=<slug> --name=<name> --summary=<text> --scope=<generic|machine> \\",
		"      (--invoke-command=<cmd> | --invoke-url=<url>) (--verify-command=<cmd> | --verify-url=<url>) \\",
		"      [--inputs-file=<json>] [--output=<text>] [--notes-file=<path>] [--timeout=<seconds>] [--skip-verify] [--json]",
		"  vcpdeck features verify <slug|id> [--client=<name|id>] [--env=<name>] [--json]",
		"  vcpdeck features update <slug|id> [--client=<name|id>] [--name=] [--summary=] [--scope=] [--invoke-command=|--invoke-url=] \\",
		"      [--verify-command=|--verify-url=] [--inputs-file=] [--output=] [--notes-file=] [--status=draft|retired] [--json]",
		"  说明: 验证由本 CLI 执行（command 型走 exec Job，http 型直连）；active 只能由成功验证产生",
	].join("\n");
}

/** 列表：默认隐藏 retired，需 --include-retired 或 --status=retired 才显示。 */
async function runListFeatures(
	argv: string[],
	client: VcpDeckClient,
	resolveId: (filter: string) => Promise<string>,
	log: (message: string) => void,
): Promise<void> {
	const { options } = parseCommandArgs(argv, {
		value: ["client", "scope", "status", "env", "page", "pageSize"],
		boolean: ["json", "include-retired"],
	});
	const clientFilter = stringOption(options, "client");
	const clientId = clientFilter ? await resolveId(clientFilter) : undefined;
	const result = await client.features.list({
		...(clientId ? { clientId } : {}),
		...(stringOption(options, "scope")
			? { scope: stringOption(options, "scope") }
			: {}),
		...(stringOption(options, "status")
			? { status: stringOption(options, "status") }
			: {}),
		page: Number(stringOption(options, "page") ?? 1),
		pageSize: Number(stringOption(options, "pageSize") ?? 20),
	});
	const items =
		options["include-retired"] === true || stringOption(options, "status") === "retired"
			? result.data
			: result.data.filter((item) => item.status !== "retired");
	if (options.json === true) {
		log(JSON.stringify({ ...result, data: items }, null, 2));
		return;
	}
	if (items.length === 0) {
		log("没有符合条件的功能条目。");
		return;
	}
	log(
		formatTable(
			items.map((item) => ({
				功能: item.name,
				slug: item.slug,
				作用域: item.scope === "generic" ? "通用" : "本机专属",
				状态: item.status,
				证据: freshnessLabel(item),
				机器: item.clientName ?? item.clientId,
			})),
			["功能", "slug", "作用域", "状态", "证据", "机器"],
		),
	);
	const hidden = result.data.length - items.length;
	log(
		`\n共 ${result.total} 条，本页显示 ${items.length} 条${
			hidden > 0
				? `（另有 ${hidden} 条 retired 已隐藏，加 --include-retired 查看）`
				: ""
		}。`,
	);
}

/** 详情：slug 命中多台机器时 fail closed。 */
async function runGetFeature(
	argv: string[],
	client: VcpDeckClient,
	resolveId: (filter: string) => Promise<string>,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["client", "env"],
		boolean: ["json"],
	});
	const key = positionals[0];
	if (!key) {
		throw new Error("用法: vcpdeck features get <slug|id> [--client=<name|id>] [--json]");
	}
	const target = await resolveTarget(client, resolveId, key, stringOption(options, "client"));
	log(options.json === true ? JSON.stringify(target, null, 2) : formatFeatureDetail(target));
}

/** 创建条目；默认内联执行一次验证，失败仍保存为 draft 但非零退出。 */
async function runAddFeature(
	argv: string[],
	client: VcpDeckClient,
	resolveId: (filter: string) => Promise<string>,
	context: FeaturesCommandContext,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: [
			"client",
			"slug",
			"name",
			"summary",
			"scope",
			"invoke-command",
			"invoke-url",
			"verify-command",
			"verify-url",
			"inputs-file",
			"output",
			"notes-file",
			"timeout",
			"env",
		],
		boolean: ["json", "skip-verify"],
	});
	if (positionals.length > 0) {
		throw new Error(`features add 不接受位置参数: ${positionals.join(" ")}`);
	}
	const clientFilter = stringOption(options, "client");
	const slug = stringOption(options, "slug");
	const name = stringOption(options, "name");
	const summary = stringOption(options, "summary");
	if (!clientFilter || !slug || !name || !summary) {
		throw new Error("features add 必须提供 --client / --slug / --name / --summary");
	}
	const scope = stringOption(options, "scope") ?? "machine";
	if (scope !== "generic" && scope !== "machine") {
		throw new Error("--scope 只接受 generic 或 machine");
	}
	const timeoutSeconds = Number(stringOption(options, "timeout") ?? 60);
	const invoke = buildInvocation(
		stringOption(options, "invoke-command"),
		stringOption(options, "invoke-url"),
		"POST",
		timeoutSeconds,
	);
	const verify = buildInvocation(
		stringOption(options, "verify-command"),
		stringOption(options, "verify-url"),
		"GET",
		timeoutSeconds,
	);
	const inputsFile = stringOption(options, "inputs-file");
	const inputs = inputsFile
		? parseFeatureInputs(JSON.parse(await readFile(inputsFile, "utf8")))
		: [];
	const notesFile = stringOption(options, "notes-file");
	const notes = notesFile ? await readFile(notesFile, "utf8") : "";
	const clientId = await resolveId(clientFilter);
	const resolved =
		options["skip-verify"] === true
			? undefined
			: await runVerification(
					client,
					clientId,
					verify,
					context.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
					log,
				);
	const created = await client.features.create({
		clientId,
		slug,
		name,
		summary,
		scope,
		invoke,
		verify,
		inputs,
		output: stringOption(options, "output") ?? "",
		notes,
		sourceJobId: resolved?.jobId ?? null,
		...(resolved
			? {
					verification: {
						ok: resolved.ok,
						durationMs: resolved.durationMs,
						evidence: resolved.evidence,
						via: "cli" as const,
					},
				}
			: {}),
	});
	if (options.json === true) {
		log(JSON.stringify(created, null, 2));
	} else {
		log(
			created.status === "active"
				? `已登记并验证通过：${created.slug}（${created.id}）`
				: `已登记为 draft：${created.slug}（${created.id}）`,
		);
	}
	if (resolved && !resolved.ok) {
		throw new Error(`验证失败：${resolved.evidence}；条目已保存为 draft`);
	}
}

/** 重新验证：这是把条目刷成 active 的唯一入口。 */
async function runVerifyFeature(
	argv: string[],
	client: VcpDeckClient,
	resolveId: (filter: string) => Promise<string>,
	context: FeaturesCommandContext,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["client", "env"],
		boolean: ["json"],
	});
	const key = positionals[0];
	if (!key) {
		throw new Error("用法: vcpdeck features verify <slug|id> [--client=<name|id>] [--json]");
	}
	const target = await resolveTarget(
		client,
		resolveId,
		key,
		stringOption(options, "client"),
	);
	const outcome = await runVerification(
		client,
		target.clientId,
		target.verify,
		context.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		log,
	);
	const updated = await client.features.reportVerification(target.id, {
		ok: outcome.ok,
		durationMs: outcome.durationMs,
		evidence: outcome.evidence,
		via: "cli",
	});
	log(options.json === true ? JSON.stringify(updated, null, 2) : formatFeatureDetail(updated));
	if (!outcome.ok) {
		throw new Error(`验证失败：${outcome.evidence}；条目已降为 draft`);
	}
}

/** 更新契约或人工降级/退役；`active` 在参数层直接拒绝。 */
async function runUpdateFeature(
	argv: string[],
	client: VcpDeckClient,
	resolveId: (filter: string) => Promise<string>,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: [
			"client",
			"name",
			"summary",
			"scope",
			"invoke-command",
			"invoke-url",
			"verify-command",
			"verify-url",
			"inputs-file",
			"output",
			"notes-file",
			"status",
			"env",
		],
		boolean: ["json"],
	});
	const key = positionals[0];
	if (!key) {
		throw new Error("用法: vcpdeck features update <slug|id> [--client=<name|id>] [字段...]");
	}
	const status = stringOption(options, "status");
	if (status === "active") {
		throw new Error("status=active 只能由一次成功验证产生；请改用 features verify");
	}
	if (status !== undefined && status !== "draft" && status !== "retired") {
		throw new Error("--status 只接受 draft 或 retired");
	}
	const target = await resolveTarget(
		client,
		resolveId,
		key,
		stringOption(options, "client"),
	);
	const patch: Record<string, unknown> = {};
	const name = stringOption(options, "name");
	if (name !== undefined) patch.name = name;
	const summary = stringOption(options, "summary");
	if (summary !== undefined) patch.summary = summary;
	const scope = stringOption(options, "scope");
	if (scope !== undefined) patch.scope = scope;
	if (stringOption(options, "invoke-command") || stringOption(options, "invoke-url")) {
		patch.invoke = buildInvocation(
			stringOption(options, "invoke-command"),
			stringOption(options, "invoke-url"),
			"POST",
			target.invoke.timeoutSeconds,
		);
	}
	if (stringOption(options, "verify-command") || stringOption(options, "verify-url")) {
		patch.verify = buildInvocation(
			stringOption(options, "verify-command"),
			stringOption(options, "verify-url"),
			"GET",
			target.verify.timeoutSeconds,
		);
	}
	const inputsFile = stringOption(options, "inputs-file");
	if (inputsFile !== undefined) {
		patch.inputs = parseFeatureInputs(JSON.parse(await readFile(inputsFile, "utf8")));
	}
	const output = stringOption(options, "output");
	if (output !== undefined) patch.output = output;
	const notesFile = stringOption(options, "notes-file");
	if (notesFile !== undefined) patch.notes = await readFile(notesFile, "utf8");
	if (status !== undefined) patch.status = status;
	if (Object.keys(patch).length === 0) {
		throw new Error("没有可更新的字段");
	}
	const updated = await client.features.update(target.id, patch);
	log(options.json === true ? JSON.stringify(updated, null, 2) : formatFeatureDetail(updated));
}

/** 按 slug 或 id 定位条目；多台机器命中时 fail closed。 */
async function resolveTarget(
	client: VcpDeckClient,
	resolveId: (filter: string) => Promise<string>,
	key: string,
	clientFilter: string | undefined,
): Promise<FeatureInfo> {
	const clientId = clientFilter ? await resolveId(clientFilter) : undefined;
	const result = await client.features.list({
		...(clientId ? { clientId } : {}),
		pageSize: 100,
	});
	const matches = result.data.filter((item) => item.slug === key || item.id === key);
	if (matches.length === 0) {
		throw new Error(`未找到功能 "${key}"；先用 vcpdeck features list 查看`);
	}
	if (matches.length > 1) {
		throw new Error(
			`功能 "${key}" 存在于多台机器：${matches.map((item) => item.clientName ?? item.clientId).join("、")}；请用 --client 指定`,
		);
	}
	return matches[0];
}

/** 构造调用契约；command 与 url 必须二选一。 */
function buildInvocation(
	commandOption: string | undefined,
	urlOption: string | undefined,
	method: "GET" | "POST",
	timeoutSeconds: number,
): FeatureInvocation {
	if (Boolean(commandOption) === Boolean(urlOption)) {
		throw new Error("必须且只能提供命令或 URL 之一");
	}
	if (commandOption) {
		return { kind: "command", command: commandOption, timeoutSeconds };
	}
	return { kind: "http", method, url: urlOption ?? "", timeoutSeconds };
}

interface VerificationOutcome {
	ok: boolean;
	evidence: string;
	durationMs: number;
	/** command 型验证创建的 exec Job；写入 sourceJobId 供审计。 */
	jobId?: string;
}

/**
 * 执行一次验证：command 型在 host 上跑 exec Job，http 型由 CLI 直连。
 * Server 不代验，因此这里的结果才是证据来源。
 */
async function runVerification(
	client: VcpDeckClient,
	clientId: string,
	verify: FeatureInvocation,
	pollIntervalMs: number,
	log: (message: string) => void,
): Promise<VerificationOutcome> {
	const startedAt = Date.now();
	if (verify.kind === "http") {
		let evidence: string;
		let ok = false;
		try {
			const response = await fetch(verify.url, {
				method: verify.method,
				signal: AbortSignal.timeout(verify.timeoutSeconds * 1_000),
			});
			ok = response.ok;
			evidence = `HTTP ${response.status}`;
		} catch (error) {
			evidence = `请求失败：${error instanceof Error ? error.message : String(error)}`;
		}
		return { ok, evidence, durationMs: Date.now() - startedAt };
	}
	const job = await client.jobs.create({
		clientId,
		type: "exec",
		payload: { mode: "command", command: verify.command },
		timeout: verify.timeoutSeconds * 1_000,
	});
	log(`[vcpdeck] 验证命令已下发: ${job.jobId}`);
	const terminal = await waitForTerminalJob(
		client,
		job.jobId,
		verify.timeoutSeconds + 30,
		log,
		pollIntervalMs,
	);
	const exitCode = (terminal.result as { exitCode?: number } | null)?.exitCode;
	const ok = terminal.status === JobStatus.DONE && exitCode === 0;
	return {
		ok,
		evidence: `job ${job.jobId} status=${terminal.status} exitCode=${exitCode ?? "null"}`,
		durationMs: Date.now() - startedAt,
		jobId: job.jobId,
	};
}

/** 证据年龄文案：缺失、失败、过期、新鲜四种；退役条目显式标注。 */
function freshnessLabel(feature: FeatureInfo): string {
	if (feature.freshness === "never" || feature.lastVerifiedAt === null) {
		return feature.status === "retired" ? "已退役（从未验证）" : "从未验证";
	}
	const days = Math.floor(
		(Date.now() - new Date(feature.lastVerifiedAt).getTime()) / 86_400_000,
	);
	const when = days === 0 ? "今天" : `${days} 天前`;
	// 最近一次验证失败时不得显示“通过”，否则会与 draft 状态自相矛盾
	const base =
		feature.lastVerifiedOk === false
			? `最新验证失败（${when}）`
			: feature.freshness === "stale"
				? `已 ${days} 天未验证`
				: `${when}通过`;
	return feature.status === "retired" ? `已退役（${base}）` : base;
}

/** 人类可读详情。 */
function formatFeatureDetail(feature: FeatureInfo): string {
	const invocation = (value: FeatureInvocation): string =>
		value.kind === "command"
			? `command: ${value.command}（timeout ${value.timeoutSeconds}s）`
			: `${value.method} ${value.url}（timeout ${value.timeoutSeconds}s）`;
	return [
		`${feature.name}（${feature.slug}）`,
		`  作用域: ${feature.scope === "generic" ? "通用" : "本机专属"}`,
		`  机器: ${feature.clientName ?? feature.clientId}（${feature.clientId}）`,
		`  状态: ${feature.status}｜证据: ${freshnessLabel(feature)}`,
		`  调用: ${invocation(feature.invoke)}`,
		`  验证: ${invocation(feature.verify)}`,
		feature.inputs.length > 0
			? `  参数: ${feature.inputs
					.map(
						(input) =>
							`${input.name}(${input.type}${input.required ? ",必填" : ""})`,
					)
					.join("、")}`
			: "  参数: 无",
		`  产物: ${feature.output || "—"}`,
		`  备注: ${feature.notes || "—"}`,
		`  证据详情: ${feature.lastVerifyEvidence ?? "—"}（来源 ${feature.verifiedVia ?? "—"}）`,
		`  id: ${feature.id}`,
	].join("\n");
}
