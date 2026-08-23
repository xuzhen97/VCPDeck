import { io as ioClient } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { resolveClientId } from "./client-resolver.js";
import type { ConfigPaths } from "./config.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";
import { formatTable } from "./table.js";

/** attach 数据面 socket 的最小接口；测试可注入替身。 */
export interface AttachSocket {
	on(event: string, listener: (payload: unknown) => void): void;
	emit(
		event: string,
		payload?: unknown,
		ack?: (response: unknown) => void,
	): void;
	disconnect(): void;
}

export type SocketFactory = (
	url: string,
	auth: Record<string, unknown>,
) => AttachSocket;

/** Terminal 命令运行时依赖，测试可注入。 */
export interface TerminalCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	/** attach 数据面 socket 工厂与终端流；测试可注入。 */
	socketFactory?: SocketFactory;
	input?: NodeJS.ReadableStream;
	stdout?: NodeJS.WritableStream & { columns?: number; rows?: number };
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
		((subcommand === "new" ||
			subcommand === "shells" ||
			subcommand === "list" ||
			subcommand === "close" ||
			subcommand === undefined) &&
			hasHelp(argv));
	if (helpRequested) {
		(context.log ?? console.log)(terminalUsage());
		return;
	}
	if (subcommand === "new") {
		await runNew(argv, context);
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
	if (subcommand === "attach") {
		await runAttach(argv, context);
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
		"  vcpdeck terminal new <client> [--shell=<id>] [--cols=<n>] [--rows=<n>] [--env=<name>] [--json]  # 创建会话，返回 sessionId",
		"  vcpdeck terminal shells <client> [--env=<name>] [--json]",
		"  vcpdeck terminal list <client> [--status=<status>] [--env=<name>] [--json]",
		"  vcpdeck terminal close <client> <sessionId> [--env=<name>] [--json]  # 写操作，会话将被终止",
		"  vcpdeck terminal attach <client> <sessionId> [--env=<name>]  # 本地终端直连远端 PTY；Ctrl+Q 退出",
		"  # 交互式 PTY 输入输出经 /app 数据面（Bearer 握手认证），CLI 仅管理生命周期",
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

/** 创建终端会话：缺省选 isDefault shell；返回 sessionId 供 attach 使用。 */
async function runNew(
	argv: string[],
	context: TerminalCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "shell", "cols", "rows"],
		boolean: ["json"],
	});
	const [clientFilter] = positionals;
	if (!clientFilter || positionals.length > 1) throw new Error(terminalUsage());
	const { environment, client } = await openContext(context, options);
	const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
	const log = context.log ?? console.log;
	const shells = (await client.terminals.shells(clientId)) as Array<{
		id: string;
		label?: string;
		isDefault?: boolean;
	}>;
	const shellOption = stringOption(options, "shell");
	const shell =
		shells.find((item) => item.id === shellOption) ??
		shells.find((item) => item.isDefault) ??
		shells[0];
	if (!shell) {
		throw new Error("目标机未报告可用 Shell，无法创建终端会话");
	}
	const cols = parseTerminalSize(stringOption(options, "cols"), "--cols", 120);
	const rows = parseTerminalSize(stringOption(options, "rows"), "--rows", 30);
	const created = (await client.terminals.create(clientId, {
		shellId: shell.id,
		cols,
		rows,
	})) as { sessionId: string; status?: string; shellLabel?: string };
	if (options.json === true) {
		log(JSON.stringify(created, null, 2));
		return;
	}
	log(formatEnvironmentSummary(environment));
	log(`[vcpdeck] 已创建终端会话 ${created.sessionId}\n（${created.shellLabel ?? shell.label ?? shell.id}，${cols}x${rows}）`);
	log(`[vcpdeck] 连接: vcpdeck terminal attach ${clientFilter} ${created.sessionId}`);
}

/** 解析终端尺寸选项：非整数或越界时报错。 */
function parseTerminalSize(raw: string | undefined, flag: string, fallback: number): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 2 || value > 500) {
		throw new Error(`${flag} 必须是 2-500 的整数`);
	}
	return value;
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

interface AttachAck {
	ok: boolean;
	data?: { attachmentId: string; reconnectToken?: string; mode?: string };
	error?: { code: string; message: string };
}

interface OutputChunk {
	sessionId: string;
	seq: number;
	data: string;
}

/**
 * 本地终端直连远端 PTY（数据面：/app 命名空间，Bearer 握手认证）。
 * raw mode 按键直传、输出直写，支持 resize 同步与 Ctrl+Q 安全退出；仅支持 Bearer 环境。
 */
async function runAttach(
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
	const environment = await resolveEnvironment({
		environment: stringOption(options, "env"),
		paths: context.paths,
		processEnv: context.processEnv,
	});
	// v1 仅 Bearer 环境：密码环境的登录态为进程内 cookie，无法传给 socket 握手
	const credentials = environment.credentials;
	if (!credentials || credentials.type !== "bearer") {
		throw new Error(
			"terminal attach 需要 Bearer 环境（env add --token-env=...）；密码环境暂不支持",
		);
	}
	const client = await createAuthenticatedClient(environment);
	const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
	const info = (await client.terminals.get(clientId, sessionId)) as {
		shellLabel?: string;
		status?: string;
	};
	const log = context.log ?? console.log;
	log(
		`[vcpdeck] attach ${clientFilter} 会话 ${sessionId}（${info?.shellLabel ?? "?"}, status=${info?.status ?? "?"}）；Ctrl+Q 退出`,
	);

	const stdout = context.stdout ?? process.stdout;
	const stdin = context.input ?? process.stdin;
	const socketFactory = context.socketFactory ?? ((url, auth) => ioClient(url, { auth, transports: ["websocket"] }) as unknown as AttachSocket);
	const socket = socketFactory(`${environment.server}/app`, {
		token: credentials.token,
	});

	let attachmentId: string | null = null;
	let closed = false;
	const exitCode = 0;
	const rawStdin = stdin as NodeJS.ReadStream & {
		setRawMode?: (mode: boolean) => void;
	};
	const cleanup = () => {
		if (closed) return;
		closed = true;
		rawStdin.setRawMode?.(false);
		stdin.pause();
		socket.disconnect();
	};

	socket.on("connect_error", (payload: unknown) => {
		const err = payload as Error;
		cleanup();
		process.exitCode = 1;
		log(`[vcpdeck] 连接失败: ${err.message}`);
	});
	socket.on(Events.TERMINAL_OUTPUT, (payload) => {
		const chunk = payload as OutputChunk;
		if (!chunk || typeof chunk.data !== "string") return;
		stdout.write(chunk.data);
		socket.emit(Events.TERMINAL_ACK_OUTPUT, {
			sessionId,
			attachmentId,
			seq: chunk.seq,
		});
	});
	socket.on(Events.TERMINAL_SNAPSHOT, (payload) => {
		const snapshot = payload as { data?: string };
		if (typeof snapshot?.data === "string") stdout.write(snapshot.data);
	});
	socket.on(Events.TERMINAL_EXIT, () => {
		log("\n[vcpdeck] 会话已结束");
		cleanup();
	});
	socket.on("disconnect", () => {
		if (!closed) log("\n[vcpdeck] 连接已断开");
	});

	socket.emit(
		Events.TERMINAL_ATTACH,
		{ sessionId },
		(response: unknown) => {
			const ack = response as AttachAck;
			if (!ack?.ok) {
				cleanup();
				process.exitCode = 1;
				log(`[vcpdeck] attach 失败: ${ack?.error?.message ?? "未知错误"}`);
				return;
			}
			attachmentId = ack.data?.attachmentId ?? null;
			rawStdin.setRawMode?.(true);
			stdin.resume();
			const sendResize = () => {
				if (closed || !attachmentId) return;
				socket.emit(Events.TERMINAL_RESIZE, {
					sessionId,
					attachmentId,
					cols: stdout.columns ?? 80,
					rows: stdout.rows ?? 24,
				});
			};
			sendResize();
			stdout.on?.("resize", sendResize);
			stdin.on("data", (buf: Buffer) => {
				if (closed) return;
				if (buf.includes(0x11)) {
					socket.emit(Events.TERMINAL_DETACH, { sessionId, attachmentId });
					cleanup();
					log("\n[vcpdeck] 已退出 attach");
					return;
				}
				socket.emit(Events.TERMINAL_INPUT, {
					sessionId,
					attachmentId,
					data: buf.toString("latin1"),
				});
			});
			void exitCode;
		},
	);
}
