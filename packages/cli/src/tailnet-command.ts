import type { Readable } from "node:stream";
import {
	JobStatus,
	parseTailnetKeyInput,
	type TailnetJobPayload,
	type TailnetKeyInfo,
	type TailnetSnapshot,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { resolveClientId } from "./client-resolver.js";
import type { ConfigPaths } from "./config.js";
import { resolveEnvironment } from "./environment.js";
import { waitForTerminalJob } from "./jobs-command.js";

/** Tailnet 命令运行时依赖；测试可注入配置、stdin 与客户端。 */
export interface TailnetCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	error?: (message: string) => void;
	/** 明文密钥只允许从这里读取；缺省使用 process.stdin。 */
	stdin?: Readable;
	/** 覆盖 TTY 判定；测试可模拟终端拒绝。 */
	stdinIsTTY?: boolean;
	/** 等待轮询间隔，测试可调小。 */
	pollIntervalMs?: number;
	/** 已认证客户端，供测试或上层复用；缺省按环境创建。 */
	client?: VcpDeckClient;
}

const MAX_KEY_BYTES = 4096;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 120;

/** 执行 Tailnet 命令组（keys / status / inspect / ensure）。 */
export async function runTailnetCommand(
	subcommand: string | undefined,
	args: string[],
	context: TailnetCommandContext = {},
): Promise<void> {
	if (
		subcommand === undefined ||
		subcommand === "--help" ||
		subcommand === "-h" ||
		args.includes("--help") ||
		args.includes("-h")
	) {
		(context.log ?? console.log)(tailnetUsage());
		return;
	}
	switch (subcommand) {
		case "keys":
			await runKeysCommand(args[0], args.slice(1), context);
			return;
		case "status":
			await runStatusCommand(args, context);
			return;
		case "inspect":
			await runManageCommand("inspect", args, context);
			return;
		case "ensure":
			await runManageCommand("ensure", args, context);
			return;
		default:
			throw new Error(`未知 tailnet 子命令: ${subcommand}\n\n${tailnetUsage()}`);
	}
}

function tailnetUsage(): string {
	return [
		"Tailnet 命令（ADR-0062；仅使用官方 Tailscale）:",
		"  vcpdeck tailnet keys import --name=<name> --key-stdin [--reuse=unknown|single|reusable] [--expires-at=<ISO>] [--env=<name>] [--json]",
		"  vcpdeck tailnet keys list [--page=<n>] [--page-size=<n>] [--env=<name>] [--json]",
		"  vcpdeck tailnet keys delete <id> [--env=<name>]",
		"  vcpdeck tailnet status <client-name-or-id> [--env=<name>] [--json]",
		"  vcpdeck tailnet inspect <client-name-or-id> [--wait] [--env=<name>] [--json]",
		"  vcpdeck tailnet ensure <client-name-or-id> --key-id=<id> [--install-if-missing] [--wait] [--env=<name>] [--json]",
		"",
		"--key-stdin 从受限本地文件重定向读取，拒绝终端直接输入；不提供明文 argv。",
		"删除只移除本地密文记录，不会撤销或退出 Provider 侧 Tailnet。",
	].join("\n");
}

async function runKeysCommand(
	action: string | undefined,
	argv: string[],
	context: TailnetCommandContext,
): Promise<void> {
	if (action === "import") return runImportKey(argv, context);
	if (action === "list") return runListKeys(argv, context);
	if (action === "delete") return runDeleteKey(argv, context);
	throw new Error(tailnetUsage());
}

function environmentOption(
	options: Record<string, string | true>,
): string | undefined {
	return stringOption(options, "env") ?? stringOption(options, "environment");
}

async function authenticatedClient(
	options: Record<string, string | true>,
	context: TailnetCommandContext,
): Promise<VcpDeckClient> {
	if (context.client) return context.client;
	const environment = await resolveEnvironment({
		environment: environmentOption(options),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	return createAuthenticatedClient(environment);
}

async function readStdinLimited(
	stream: Readable,
	limit: number,
): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of stream) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		bytes += buffer.length;
		if (bytes > limit) throw new Error("密钥输入超过 4096 字节上限");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function runImportKey(
	argv: string[],
	context: TailnetCommandContext,
): Promise<void> {
	const { options } = parseCommandArgs(argv, {
		value: ["name", "reuse", "expires-at", "env", "environment"],
		boolean: ["key-stdin", "json"],
	});
	const name = stringOption(options, "name");
	if (!name) throw new Error("keys import 需要 --name=<name>");
	if (options["key-stdin"] !== true) {
		throw new Error(
			"keys import 必须显式使用 --key-stdin；不接受明文 argv，示例：vcpdeck tailnet keys import --name=home --key-stdin < ./tailnet.key",
		);
	}
	const stdin = context.stdin ?? process.stdin;
	const isTTY = context.stdinIsTTY ?? process.stdin.isTTY === true;
	if (isTTY) {
		throw new Error(
			"--key-stdin 拒绝终端输入；请从权限受限的本地文件重定向，避免密钥进入屏幕或历史记录",
		);
	}
	const raw = await readStdinLimited(stdin, MAX_KEY_BYTES);
	// 仅去掉重定向文件常见的末尾换行，不 trim 正文。
	const authKey = raw.replace(/\r?\n$/, "");
	if (authKey.length === 0) throw new Error("stdin 未提供密钥");
	const reuse = stringOption(options, "reuse") ?? "unknown";
	if (reuse !== "unknown" && reuse !== "single" && reuse !== "reusable") {
		throw new Error("--reuse 必须是 unknown/single/reusable 之一");
	}
	const input = parseTailnetKeyInput({
		name,
		authKey,
		declaredReuse: reuse,
		declaredExpiresAt: stringOption(options, "expires-at") ?? null,
	});
	const client = await authenticatedClient(options, context);
	const info = await client.tailnet.importKey(input);
	const log = context.log ?? console.log;
	if (options.json === true) {
		log(JSON.stringify(info, null, 2));
		return;
	}
	log(
		`[vcpdeck] 已导入 Tailnet 凭据 ${info.id}（${info.name}，${info.declaredReuse}）；Provider 侧密钥未改变`,
	);
}

async function runListKeys(
	argv: string[],
	context: TailnetCommandContext,
): Promise<void> {
	const { options } = parseCommandArgs(argv, {
		value: ["page", "page-size", "env", "environment"],
		boolean: ["json"],
	});
	const page = parsePositiveInt(stringOption(options, "page"), "--page");
	const pageSize = parsePositiveInt(
		stringOption(options, "page-size"),
		"--page-size",
	);
	const client = await authenticatedClient(options, context);
	const result = await client.tailnet.listKeys({ page, pageSize });
	const log = context.log ?? console.log;
	if (options.json === true) {
		log(JSON.stringify(result, null, 2));
		return;
	}
	if (result.data.length === 0) {
		log("没有本地 Tailnet 凭据。");
		return;
	}
	const lines = [
		"ID\t名称\t声明复用\t用途\t过期时间",
		...result.data.map((key) =>
			[
				key.id,
				key.name,
				key.declaredReuse,
				key.use,
				key.declaredExpiresAt ?? "—",
			].join("\t"),
		),
	];
	log(lines.join("\n"));
}

async function runDeleteKey(
	argv: string[],
	context: TailnetCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment"],
		boolean: ["json"],
	});
	const id = positionals[0];
	if (!id) throw new Error("keys delete 需要凭据 id");
	const client = await authenticatedClient(options, context);
	await client.tailnet.deleteKey(id);
	const log = context.log ?? console.log;
	if (options.json === true) {
		log(JSON.stringify({ deleted: true }, null, 2));
		return;
	}
	log(
		`[vcpdeck] 已删除本地 Tailnet 凭据 ${id}；Provider 侧密钥仍需在 Tailscale 管理端自行撤销`,
	);
}

async function runStatusCommand(
	argv: string[],
	context: TailnetCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment"],
		boolean: ["json"],
	});
	const filter = positionals[0];
	if (!filter) throw new Error("status 需要机器名称或 clientId");
	const client = await authenticatedClient(options, context);
	const clientId = await resolveClientId(
		filter,
		context.paths,
		context.processEnv,
		client,
	);
	const status = await client.tailnet.status(clientId);
	const log = context.log ?? console.log;
	if (options.json === true) {
		log(JSON.stringify(status, null, 2));
		return;
	}
	log(formatStatus(clientId, status));
}

function formatStatus(
	clientId: string,
	status: {
		online: boolean;
		supported: boolean;
		snapshot: TailnetSnapshot | null;
	},
): string {
	const lines = [
		`[tailnet] ${clientId} · ${status.online ? "在线" : "离线"}`,
		status.supported
			? "能力: 支持 Tailnet 管理（协议 v1）"
			: "能力: 旧版 Client 未声明 Tailnet 管理",
	];
	if (!status.snapshot) {
		lines.push("观测: 未知 / 未报告（没有可用的历史摘要）");
		return lines.join("\n");
	}
	const snapshot = status.snapshot;
	lines.push(
		`观测时间: ${snapshot.observedAt}${status.online ? "" : "（历史，不代表当前可达）"}`,
	);
	lines.push(
		[
			`Tailscale: installed=${snapshot.installed}`,
			`service=${snapshot.service}`,
			`backend=${snapshot.backend}`,
			`version=${snapshot.version ?? "—"}`,
		].join(" "),
	);
	if (snapshot.nodeName) lines.push(`节点: ${snapshot.nodeName}`);
	const addresses = [...snapshot.ipv4, ...snapshot.ipv6];
	if (addresses.length > 0) lines.push(`地址: ${addresses.join(", ")}`);
	if (snapshot.errorCode) lines.push(`错误码: ${snapshot.errorCode}`);
	if (snapshot.backend === "needs-approval") {
		lines.push("提示: 等待 Tailscale 管理端批准，尚不可达");
	}
	return lines.join("\n");
}

async function runManageCommand(
	action: "inspect" | "ensure",
	argv: string[],
	context: TailnetCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["key-id", "env", "environment", "wait-timeout"],
		boolean: ["json", "wait", "install-if-missing"],
	});
	const filter = positionals[0];
	if (!filter) throw new Error(`${action} 需要机器名称或 clientId`);
	if (action === "ensure") {
		if (!stringOption(options, "key-id")) {
			throw new Error("ensure 需要 --key-id=<id>");
		}
		if (positionals.length > 1) {
			throw new Error("ensure 只接受单台机器；批量请逐个执行");
		}
	}
	const client = await authenticatedClient(options, context);
	const clientId = await resolveClientId(
		filter,
		context.paths,
		context.processEnv,
		client,
	);
	const payload: TailnetJobPayload =
		action === "inspect"
			? { action: "inspect" }
			: {
					action: "ensure",
					credentialId: stringOption(options, "key-id") as string,
					installIfMissing: options["install-if-missing"] === true,
				};
	const created = await client.tailnet.manage(clientId, payload);
	const log = context.log ?? console.log;
	const error = context.error ?? console.error;
	if (options.json === true) {
		if (options.wait !== true) {
			log(JSON.stringify(created, null, 2));
			return;
		}
		const job = await waitForTerminalJob(
			client,
			created.jobId,
			parseWaitTimeout(options),
			error,
			context.pollIntervalMs ?? 1_000,
		);
		log(JSON.stringify(job, null, 2));
		if (job.status !== JobStatus.DONE) {
			throw new Error(`Job ${job.jobId} 终态为 ${job.status}`);
		}
		return;
	}
	log(
		`[vcpdeck] Tailnet ${action} Job 已创建: ${created.jobId}（${created.status}）`,
	);
	if (options.wait !== true) {
		log(`用 vcpdeck jobs get ${created.jobId} 查询结果，或加 --wait 等待终态`);
		return;
	}
	const job = await waitForTerminalJob(
		client,
		created.jobId,
		parseWaitTimeout(options),
		log,
		context.pollIntervalMs ?? 1_000,
	);
	if (job.status !== JobStatus.DONE) {
		throw new Error(`Job ${job.jobId} 终态为 ${job.status}`);
	}
	const stage =
		job.result && typeof job.result.stage === "string" ? job.result.stage : null;
	if (stage === "awaiting-approval") {
		log("等待 Tailscale 管理端批准（awaiting-approval）；批准前该机器尚不可达。");
	} else if (stage === "joined") {
		log("已加入 Tailnet（joined）。");
	} else if (stage) {
		log(`阶段: ${stage}`);
	}
}

function parseWaitTimeout(options: Record<string, string | true>): number {
	const raw = stringOption(options, "wait-timeout");
	if (raw === undefined) return DEFAULT_WAIT_TIMEOUT_SECONDS;
	const seconds = Number(raw);
	if (!Number.isInteger(seconds) || seconds < 1) {
		throw new Error("--wait-timeout 必须是不小于 1 的整数秒");
	}
	return seconds;
}

function parsePositiveInt(
	raw: string | undefined,
	flag: string,
): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${flag} 必须是不小于 1 的整数`);
	}
	return value;
}

/** 导出供测试复用：只读摘要渲染不把历史观测误报为当前未入网。 */
export function formatTailnetStatusForTest(
	clientId: string,
	status: Parameters<typeof formatStatus>[1],
): string {
	return formatStatus(clientId, status);
}

export type { TailnetKeyInfo };
