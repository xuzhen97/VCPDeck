/**
 * VCPDeck CLI 入口。
 *
 * 当前能力：多环境配置、Client 列表查询、Job 查询/执行/取消与失败现场、文件只读浏览与写操作/传输、FRP 查询与映射增删、Storage 查询、Terminal 生命周期与 PTY 直连、Pi 子任务与交互 REPL、Release 双平台上传及 Server/Client 自更新终态验收。
 */
import { VERSION } from "@vcpdeck/shared";
import { runEnvCommand } from "./env-command.js";
import { runFilesCommand } from "./files-command.js";
import { runJobsCommand } from "./jobs-command.js";
import { runPiCommand } from "./pi-command.js";
import { runFrpCommand } from "./frp-command.js";
import { runClientsCommand } from "./clients-command.js";
import { runReleaseCommand } from "./release-command.js";

/** CLI 运行时依赖，测试可注入输出。 */
export interface CliContext {
	log?: (message: string) => void;
	error?: (message: string) => void;
}

/** 执行 CLI 命令并返回进程退出码。 */
export async function run(
	argv: string[],
	context: CliContext = {},
): Promise<number> {
	const log = context.log ?? console.log;
	const error = context.error ?? console.error;
	const [command, subcommand, ...rest] = argv;
	try {
		if (command === "version" || command === "--version" || command === "-v") {
			log(VERSION);
			return 0;
		}
		if (command === "env") {
			await runEnvCommand(subcommand, rest, { log });
			return 0;
		}
		if (command === "pi") {
			await runPiCommand(subcommand, rest, { log });
			return 0;
		}
		if (command === "frp") {
			await runFrpCommand(subcommand, rest, { log });
			return 0;
		}
		if (command === "storage") {
			// 懒加载：命令模块按需解析，保持启动轻量
			const { runStorageCommand } = await import("./storage-command.js");
			await runStorageCommand(subcommand, rest, { log });
			return 0;
		}
		if (command === "terminal") {
			// 懒加载：attach 数据面依赖 socket.io，按需解析保持启动轻量
			const { runTerminalCommand } = await import("./terminal-command.js");
			await runTerminalCommand(subcommand, rest, { log });
			return 0;
		}
		if (command === "completions") {
			// 懒加载：补全生成只在显式调用时解析
			const { runCompletionsCommand } = await import(
				"./completions-command.js"
			);
			await runCompletionsCommand(subcommand, { log });
			return 0;
		}
		if (command === "files") {
			await runFilesCommand(subcommand, rest, { log });
			return 0;
		}
		if (command === "jobs") {
			await runJobsCommand(subcommand, rest, { log });
			return 0;
		}
		if (command === "clients") {
			await runClientsCommand(subcommand, rest, { log });
			return 0;
		}
		if (command === "release") {
			await runReleaseCommand(subcommand, rest, { log });
			return 0;
		}
		if (
			!command ||
			command === "help" ||
			command === "--help" ||
			command === "-h"
		) {
			log(helpText());
			return 0;
		}
		throw new Error(`未知命令: ${command}\n\n${helpText()}`);
	} catch (cause) {
		error(`[vcpdeck] ${messageOf(cause)}`);
		return 1;
	}
}

/** CLI 总帮助。 */
export function helpText(): string {
	return [
		"vcpdeck",
		"  vcpdeck --version",
		"",
		"环境配置:",
		"  vcpdeck env list",
		"  vcpdeck env show <name>",
		"  vcpdeck env current [--env=<name>]",
		"  vcpdeck env check [--env=<name>]",
		"  vcpdeck env add <name> --server=<url> --token-env=<VAR>",
		"  兼容密码: ... --auth=password --username=<name> --password-env=<VAR>",
		"  vcpdeck env remove <name>",
		"  vcpdeck env use <name> --global|--local",
		"",
		"Clients:",
		"  vcpdeck clients list [--env=<name>] [--json]",
		"",
		"Jobs:",
		"  vcpdeck jobs list [--client=<name|id>] [--status=<status>] [--page=<n>] [--env=<name>] [--json]",
		"  vcpdeck jobs get <jobId> [--env=<name>] [--json]",
		"  vcpdeck jobs run <client> [--cwd=<dir>] [--timeout=<seconds>] [--wait] [--wait-timeout=<seconds>] [--env=<name>] [--json] -- <command...>",
		"  vcpdeck jobs cancel <jobId> [--env=<name>] [--json]",
		"",
		"Files:",
		"  vcpdeck files roots <client> [--env=<name>] [--json]",
		"  vcpdeck files list <client> <path> [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck files stat <client> <path> [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck files read <client> <path> [--root=<dir>] [--max-bytes=<n>] [--env=<name>] [--json]",
		"  vcpdeck files write <client> <path> [--root=<dir>] [--input=<file>] [--env=<name>] [--json]",
		"  vcpdeck files mkdir <client> <path> [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck files delete <client> <path> [--root=<dir>] [--recursive] [--env=<name>] [--json]",
		"  vcpdeck files move <client> <source> <destination> [--root=<dir>] [--overwrite] [--env=<name>] [--json]",
		"  vcpdeck files download <client> <remotePath> <localPath> [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck files upload <client> <localPath> <remotePath> [--root=<dir>] [--overwrite] [--env=<name>] [--json]",
		"",
		"Pi:",
		"  vcpdeck pi models <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck pi sessions <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck pi new <client> --cwd=<path> [--root=<dir>] [--env=<name>] [--json]",
		"  vcpdeck pi run <client> \"提示词\" --cwd=<path> [--session=<id>] [--root=<dir>] [--timeout=<seconds>] [--env=<name>] [--json]",
		"  vcpdeck pi abort <client> --session=<id> [--env=<name>] [--json]",
		"",
		"FRP:",
		"  vcpdeck frp instances [--page=<n>] [--env=<name>] [--json]",
		"  vcpdeck frp mappings [--client=<name|id>] [--page=<n>] [--env=<name>] [--json]",
		"  vcpdeck frp mapping create <client> --local-port=<port> [--type=tcp|http|https] [--domain=<domain>] [--name=<name>] [--instance=<id>] [--timeout=<seconds>] [--env=<name>] [--json]",
		"  vcpdeck frp mapping delete <mappingId> [--timeout=<seconds>] [--env=<name>] [--json]",
		"",
		"Storage:",
		"  vcpdeck storage status [--env=<name>] [--json]",
		"",
		"Terminal:",
		"  vcpdeck terminal new <client> [--shell=<id>] [--cols=<n>] [--rows=<n>] [--env=<name>] [--json]",
		"  vcpdeck terminal shells <client> [--env=<name>] [--json]",
		"  vcpdeck terminal list <client> [--status=<status>] [--env=<name>] [--json]",
		"  vcpdeck terminal close <client> <sessionId> [--env=<name>] [--json]  # 写操作需确认",
		"  vcpdeck terminal attach <client> <sessionId> [--env=<name>]  # 本地终端直连远端 PTY；Ctrl+Q 退出",
		"",
		"Release:",
		"  vcpdeck release status <version> [--env=<name>]",
		"  vcpdeck release wait <version> [--env=<name>] [--timeout=<seconds>]",
		"  vcpdeck release upload <win-x64.zip> <linux-x64.zip> [--env=<name>] [--wait] [--timeout=<seconds>]",
		"  兼容直连: 添加 --server=<url> [--username=<name> --password=<value>]",
		"",
		"Shell 补全:",
		"  vcpdeck completions bash        # 输出 Bash 补全脚本（Git Bash，追加到 ~/.bashrc）",
		"  vcpdeck completions powershell  # 输出 PowerShell 补全脚本（追加到 $PROFILE）",
		"  环境增删后请重新生成以刷新 --env= 候选",
	].join("\n");
}

function messageOf(cause: unknown): string {
	if (!(cause instanceof Error)) return "未知错误";
	const code =
		"code" in cause && typeof cause.code === "string" ? cause.code : undefined;
	return `${cause.message}${code ? ` (${code})` : ""}`;
}

void run(process.argv.slice(2)).then((exitCode) => {
	process.exitCode = exitCode;
});
