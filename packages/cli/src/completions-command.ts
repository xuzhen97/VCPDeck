/**
 * Shell 命令补全生成：bash 与 PowerShell。
 *
 * 静态命令树 + 常用 flag；--env= 的候选在生成时从本地 CLI 配置嵌入，
 * 不发起网络请求、零运行时开销。环境增删后重新执行本命令刷新。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCliConfig } from "./config.js";
import type { ConfigPaths } from "./config.js";

/** 补全命令运行时依赖，测试可注入。 */
export interface CompletionsCommandContext {
	log?: (message: string) => void;
	paths?: ConfigPaths;
}

/** 顶层命令与各自子命令（与 helpText 保持同步）。 */
const COMMAND_TREE: Record<string, string[]> = {
	env: ["list", "show", "current", "check", "add", "remove", "use"],
	clients: ["list"],
	jobs: ["list", "get", "run", "cancel"],
	files: [
		"roots",
		"list",
		"stat",
		"read",
		"write",
		"mkdir",
		"delete",
		"move",
		"download",
		"upload",
	],
	pi: ["models", "sessions", "new", "run", "attach", "abort"],
	terminal: ["shells", "list", "close", "attach"],
	frp: ["instances", "mappings", "mapping"],
	storage: ["status"],
	release: ["status", "wait", "upload"],
	completions: ["bash", "powershell"],
};

const TOP_LEVEL = [...Object.keys(COMMAND_TREE), "help"];
const COMMON_FLAGS = ["--json", "--env=", "--help"];

function completionsUsage(): string {
	return [
		"用法:",
		"  vcpdeck completions bash        # 输出 Bash 补全脚本（Git Bash）",
		"  vcpdeck completions powershell  # 输出 PowerShell 补全脚本",
		"",
		"启用方式见输出头部注释；环境增删后请重新生成。",
	].join("\n");
}

async function resolveEnvironmentNames(
	paths: ConfigPaths,
): Promise<string[]> {
	try {
		const config = await loadCliConfig(paths.globalConfigPath);
		return Object.keys(config.environments ?? {}).sort((a, b) =>
			a.localeCompare(b),
		);
	} catch {
		return [];
	}
}

function generateBash(envNames: string[]): string {
	const envList = envNames.join(" ");
	const prefixed = envNames.map((n) => `--env=${n}`).join(" ");
	const caseBranches = Object.entries(COMMAND_TREE)
		.map(([cmd, subs]) => `\t\t${cmd}) subs="${subs.join(" ")}";;`)
		.join("\n");
	return `# vcpdeck Bash 补全（由 vcpdeck completions bash 生成；环境变更后请重新生成）
# 启用：把下面整段追加到 ~/.bashrc 后 source ~/.bashrc（或开新终端）
_vcpdeck() {
	local cur cmd subs
	cur="\${COMP_WORDS[COMP_CWORD]}"
	if [ "\${COMP_WORDS[1]}" ] && [ "\${COMP_CWORD}" -ge 2 ]; then :; fi
	cmd="\${COMP_WORDS[1]}"
	case "\${COMP_WORDS[COMP_CWORD-1]}" in
\t\t--env) COMPREPLY=( $(compgen -W "${envList}" -- "$cur") ); return 0 ;;
\tesac
	if [[ "$cur" == --env=* ]]; then
\t\tCOMPREPLY=( $(compgen -W "${prefixed}" -- "$cur") ); return 0
	fi
	if [[ "$cur" == -* ]]; then
\t\tCOMPREPLY=( $(compgen -W "${COMMON_FLAGS.join(" ")}" -- "$cur") ); return 0
	fi
	if [ "$COMP_CWORD" -eq 1 ]; then
\t\tCOMPREPLY=( $(compgen -W "${TOP_LEVEL.join(" ")} --version" -- "$cur") ); return 0
	fi
	subs=""
\tcase "$cmd" in
${caseBranches}
\tesac
	COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
}
complete -F _vcpdeck vcpdeck
`;
}

function generatePowerShell(envNames: string[]): string {
	const envArray = envNames.map((n) => `'${n}'`).join(",");
	const subPairs = Object.entries(COMMAND_TREE)
		.map(([cmd, subs]) => `\t'${cmd}' = @('${subs.join("','")}');`)
		.join("\n");
	return `# vcpdeck PowerShell 补全（由 vcpdeck completions powershell 生成；环境变更后请重新生成）
# 启用：把下面整段追加到 $PROFILE 后重开终端（. 或执行该文件一次亦可）
Register-ArgumentCompleter -CommandName vcpdeck -Native -ScriptBlock {
	param($wordToComplete, $commandAst)
	$envNames = @(${envArray})
	$subCommands = @{
${subPairs}
\t}
	$topLevel = @('${TOP_LEVEL.join("','")}')
	$args_ = @($commandAst.CommandElements | Select-Object -Skip 1)
	$candidates = @()
	if ($args_.Count -le 1) {
		$candidates = $topLevel + @('--version')
	} elseif ($subCommands.ContainsKey([string]$args_[0])) {
		$candidates = $subCommands[[string]$args_[0]]
	}
	if ($wordToComplete -like '--env=*') {
		$candidates = @($envNames | ForEach-Object { "--env=$_" })
	} else {
		$candidates += @('${COMMON_FLAGS.join("','")}')
	}
	$candidates |
		Where-Object { $_ -like "$wordToComplete*" } |
		ForEach-Object {
			[System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
		}
}
`;
}

/** 执行 completions 命令组：bash/powershell 两种 flavor。 */
export async function runCompletionsCommand(
	subcommand: string | undefined,
	context: CompletionsCommandContext = {},
): Promise<void> {
	const log = context.log ?? console.log;
	const paths =
		context.paths ??
		({
			globalConfigPath: join(homedir(), ".vcpdeck", "cli", "config.json"),
			cwd: process.cwd(),
		} as ConfigPaths);
	if (
		subcommand === undefined ||
		subcommand === "--help" ||
		subcommand === "-h"
	) {
		log(completionsUsage());
		return;
	}
	if (subcommand !== "bash" && subcommand !== "powershell") {
		throw new Error(`未知补全类型: ${subcommand}\n\n${completionsUsage()}`);
	}
	const envNames = await resolveEnvironmentNames(paths);
	log(
		subcommand === "bash"
			? generateBash(envNames)
			: generatePowerShell(envNames),
	);
}
