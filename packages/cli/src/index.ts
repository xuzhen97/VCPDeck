/**
 * VCPDeck CLI 入口。
 *
 * 当前能力：多环境配置、Release 双平台上传及 Server/Client 自更新终态验收。
 */
import { VERSION } from "@vcpdeck/shared";
import { runEnvCommand } from "./env-command.js";
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
		"Release:",
		"  vcpdeck release status <version> [--env=<name>]",
		"  vcpdeck release wait <version> [--env=<name>] [--timeout=<seconds>]",
		"  vcpdeck release upload <win-x64.zip> <linux-x64.zip> [--env=<name>] [--wait] [--timeout=<seconds>]",
		"  兼容直连: 添加 --server=<url> [--username=<name> --password=<value>]",
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
