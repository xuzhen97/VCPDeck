import { statSync } from "node:fs";
import { win32 } from "node:path";

/** spawn 目标：Windows 上的脚本垫片需要改写为经 cmd.exe 包装。 */
export interface SpawnTarget {
	command: string;
	args: string[];
	windowsVerbatimArguments?: boolean;
}

export interface ResolveSpawnTargetOptions {
	command: string;
	args: string[];
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** 文件存在性判定，缺省查真实文件系统；测试可注入。 */
	isFile?: (path: string) => boolean;
}

const DEFAULT_PATH_EXT = ".COM;.EXE;.BAT;.CMD";
const SCRIPT_EXTENSIONS = [".cmd", ".bat"];

function defaultIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
	const raw = env.PATHEXT ?? DEFAULT_PATH_EXT;
	return raw
		.split(";")
		.map((extension) => extension.trim())
		.filter((extension) => extension.length > 0);
}

/** 带扩展名时按原样判定；不带扩展名时按 PATHEXT 顺序补齐。 */
function withExtension(
	command: string,
	extensions: string[],
	isFile: (path: string) => boolean,
): string | undefined {
	if (win32.extname(command) !== "") {
		return isFile(command) ? command : undefined;
	}
	for (const extension of extensions) {
		const candidate = command + extension;
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

/** 按 cmd.exe 语义在 PATH 中查找：先遍历目录，目录内再按 PATHEXT 顺序。 */
function searchPath(
	command: string,
	env: NodeJS.ProcessEnv,
	isFile: (path: string) => boolean,
): string | undefined {
	const extensions = pathExtensions(env);
	const directories = (env.PATH ?? "").split(";").filter(Boolean);
	for (const directory of directories) {
		const resolved = withExtension(
			win32.join(directory, command),
			extensions,
			isFile,
		);
		if (resolved) return resolved;
	}
	return undefined;
}

/**
 * 用引号包住单个 token。
 *
 * cmd 把引号内的 `&`、`|`、`<`、`>`、`^` 当字面量，因此逐个 token 加引号可以阻止
 * 参数被解释成额外的命令。`"` 按 cmd 惯例双写转义。
 */
function quoteForCmd(token: string): string {
	return `"${token.replace(/"/g, '""')}"`;
}

/**
 * 解析真正交给 spawn 的命令与参数。
 *
 * Windows 上 Node 不能直接执行 `.cmd`/`.bat`（`spawn("dsh")` 报 ENOENT，
 * 显式 `.cmd` 路径报 EINVAL），而 CLI agent 的全局命令几乎都是这类垫片，
 * 因此按 Node 官方建议改写为 `cmd.exe /d /s /c "<命令行>"`。
 * 非 Windows 平台、`.exe`/`.com`、以及无法解析的命令都不改写。
 */
export function resolveSpawnTarget(
	options: ResolveSpawnTargetOptions,
): SpawnTarget {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") {
		return { command: options.command, args: options.args };
	}

	const env = options.env ?? process.env;
	const isFile = options.isFile ?? defaultIsFile;
	const extensions = pathExtensions(env);
	const isPath =
		win32.isAbsolute(options.command) ||
		options.command.includes("/") ||
		options.command.includes("\\");
	const resolved = isPath
		? withExtension(options.command, extensions, isFile)
		: searchPath(options.command, env, isFile);
	if (!resolved) return { command: options.command, args: options.args };

	const extension = win32.extname(resolved).toLowerCase();
	if (!SCRIPT_EXTENSIONS.includes(extension)) {
		return { command: resolved, args: options.args };
	}

	const shell = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
	const line = [resolved, ...options.args].map(quoteForCmd).join(" ");
	return {
		command: shell,
		// /s 会剥掉最外层引号，所以整条命令行必须再包一层
		args: ["/d", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
	};
}
