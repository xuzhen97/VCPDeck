/**
 * Pi 运行所需 shell 的解析（平台化，绝对路径优先）。
 *
 * 为什么需要这一层（实测驱动）：Pi SDK 自己解析 shell 的方式是环境敏感的——
 * - `bash`：`%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\...` → PATH；
 * - `powershell`：**只**走 PATH（`findExecutableOnPath("pwsh.exe") ?? ...("powershell.exe")`），
 *   而 Client 以 SYSTEM 计划任务运行时 PATH 可能被裁剪（实测某机器只有 System32，找不到
 *   `WindowsPowerShell\v1.0`）。
 *
 * 因此这里自己按绝对路径候选解析，并把结果交给两处使用：
 * 1. `capability.ts` 上报能力（shellKind 仅作诊断，不再作为整机门禁）；
 * 2. `index.ts` fork Pi worker 时把 `pathDirs` 前置到子进程 PATH，使 SDK 的 PATH 解析
 *    在任意环境下都命中同一份结果；`agent-session.ts` 用 `bash` 绝对路径注入内存 settings
 *    （`Settings.shellPath`，SDK 的 bash 工具会直接采用）。
 *
 * 注意：Windows 上「本机没有 bash」不是失败——Pi 的 Windows 语义是 PowerShell 可用、bash 可选
 * （SDK 的 bash 与 powershell 是并列工具，见 `PI_BUILTIN_TOOL_IDS`）。
 */
import { access } from "node:fs/promises";
import { delimiter, posix, win32 } from "node:path";

/** shell 解析结果；null 表示该 shell 在本机不可用。 */
export interface PiShellResolution {
	/** bash 绝对路径；null = bash 工具不可用（Windows 上完全合法）。 */
	bash: string | null;
	/** bash 来源，与 `PiCapabilityStatus.shellKind` 同一取值空间；无 bash 时为 null。 */
	bashSource: "git-bash" | "path" | "system" | null;
	/** PowerShell 绝对路径；非 Windows 恒为 null。 */
	powershell: string | null;
	/** 应前置到子进程 PATH 的目录（去重、保序）；供 SDK 的 PATH 解析命中。 */
	pathDirs: string[];
}

/** shell 解析环境抽象（测试注入）。 */
export interface PiShellEnv {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** 文件存在性检查。 */
	exists: (path: string) => Promise<boolean>;
	/** 在 PATH 中查找可执行文件（返回绝对路径或 null）。 */
	findInPath: (name: string) => Promise<string | null>;
}

async function exists(p: string): Promise<boolean> {
	return access(p).then(
		() => true,
		() => false,
	);
}

/** 按**目标平台**选择路径语义（与 runtime-paths.ts 同一做法），避免在非目标平台上生成错误分隔符。 */
function pathApiFor(platform: NodeJS.Platform): typeof win32 {
	return platform === "win32" ? win32 : (posix as typeof win32);
}

/** PATH 中的可执行文件解析（Windows 补 PATHEXT）。 */
async function findInPath(
	name: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	const p = pathApiFor(platform);
	const pathValue = env.PATH ?? env.Path ?? "";
	const dirs = pathValue.split(delimiter).filter(Boolean);
	const exts =
		platform === "win32"
			? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
			: [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = p.join(dir, `${name}${ext}`);
			if (await exists(candidate)) return candidate;
		}
	}
	return null;
}

/** 生成真实解析环境。 */
export function createPiShellEnv(): PiShellEnv {
	return {
		platform: process.platform,
		env: process.env,
		exists,
		findInPath: (name) => findInPath(name, process.platform, process.env),
	};
}

/** 首个存在者；全部不存在返回 null。dirs = 尝试过但不存在的候选所在目录（不含命中者自己的目录）。 */
async function firstExisting(
	candidates: Array<string | undefined>,
	check: (path: string) => Promise<boolean>,
	p: typeof win32,
): Promise<{ path: string | null; dirs: string[] }> {
	const dirs: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (await check(candidate)) return { path: candidate, dirs };
		dirs.push(p.dirname(candidate));
	}
	return { path: null, dirs };
}

/** 把命中路径自身所在目录放到最前（SDK 的 PATH 解析（`where`）必须能命中它）。 */
function withOwnDir(
	path: string | null,
	dirs: string[],
	p: typeof win32,
): string[] {
	return path ? [p.dirname(path), ...dirs] : dirs;
}

/**
 * 解析 bash：先绝对路径候选（带来源标签），再回退 PATH。
 * 绝对路径候选用 [候选, 来源] 二元组表达，使 Windows Git Bash 与 POSIX 系统 bash 可区分。
 */
async function resolveBash(
	candidates: Array<[string | undefined, "git-bash" | "system"]>,
	env: PiShellEnv,
): Promise<{ path: string | null; source: PiShellResolution["bashSource"]; dirs: string[] }> {
	const p = pathApiFor(env.platform);
	const dirs: string[] = [];
	for (const [candidate, source] of candidates) {
		if (!candidate) continue;
		if (await env.exists(candidate)) return { path: candidate, source, dirs };
		dirs.push(p.dirname(candidate));
	}
	const onPath = await env.findInPath(env.platform === "win32" ? "bash.exe" : "bash");
	if (onPath) {
		return { path: onPath, source: "path", dirs };
	}
	return { path: null, source: null, dirs };
}

/** 解析本机可用 shell；结果不含凭据，只含路径事实。 */
export async function resolvePiShells(
	env: PiShellEnv = createPiShellEnv(),
): Promise<PiShellResolution> {
	const p = pathApiFor(env.platform);
	if (env.platform !== "win32") {
		const shellEnv = env.env.SHELL?.trim();
		const bash = await resolveBash(
			[
				[shellEnv?.includes("/") ? shellEnv : undefined, "system"],
				["/bin/bash", "system"],
				["/usr/bin/bash", "system"],
			],
			env,
		);
		return {
			bash: bash.path,
			bashSource: bash.source,
			powershell: null,
			pathDirs: dedupe(withOwnDir(bash.path, bash.dirs, p)),
		};
	}

	const programFiles = env.env.ProgramFiles;
	const programFilesX86 = env.env["ProgramFiles(x86)"];
	const systemRoot = env.env.SystemRoot ?? env.env.windir;

	const bash = await resolveBash(
		[
			[
				programFiles && p.join(programFiles, "Git", "bin", "bash.exe"),
				"git-bash",
			],
			[
				programFilesX86 && p.join(programFilesX86, "Git", "bin", "bash.exe"),
				"git-bash",
			],
		],
		env,
	);

	const powershell = await firstExisting(
		[
			systemRoot &&
				p.join(
					systemRoot,
					"System32",
					"WindowsPowerShell",
					"v1.0",
					"powershell.exe",
				),
			programFiles && p.join(programFiles, "PowerShell", "7", "pwsh.exe"),
		],
		env.exists,
		p,
	);
	let powershellPath = powershell.path;
	const powershellDirs = [...powershell.dirs];
	if (!powershellPath) {
		const onPath =
			(await env.findInPath("pwsh.exe")) ??
			(await env.findInPath("powershell.exe"));
		if (onPath) {
			powershellPath = onPath;
			powershellDirs.push(p.dirname(onPath));
		}
	}

	return {
		bash: bash.path,
		bashSource: bash.source,
		powershell: powershellPath,
		pathDirs: dedupe([
			...withOwnDir(powershellPath, powershellDirs, p),
			...withOwnDir(bash.path, bash.dirs, p),
		]),
	};
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

/**
 * 把 shell 目录前置到子进程 PATH：SDK 的 `findExecutableOnPath` 走 `where`/`which`，
 * 依赖进程 PATH；不注入时 PATH 被裁剪的机器会解析失败。
 */
export function prependShellPathDirs(
	resolution: PiShellResolution,
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	if (resolution.pathDirs.length === 0) return env;
	const pathKey = shellPathKey(env);
	const current = env[pathKey] ?? "";
	const merged = [...resolution.pathDirs, current].filter(Boolean).join(delimiter);
	return { ...env, [pathKey]: merged };
}

/** 只就地改写 PATH 本身（不重写整个 env），供进程启动时调用。 */
export function applyShellPathDirs(
	resolution: PiShellResolution,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (resolution.pathDirs.length === 0) return;
	const pathKey = shellPathKey(env);
	const merged = prependShellPathDirs(resolution, env)[pathKey];
	if (merged !== undefined) env[pathKey] = merged;
}

/** 原 PATH 变量名大小写（Windows 上常见 `Path`）：就地改写时必须沿用同一 key。 */
function shellPathKey(env: NodeJS.ProcessEnv): string {
	return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

/**
 * 按平台过滤工具集合：去掉本机无法提供的 shell 工具。
 * 非 Windows 的 `powershell` 与 Windows 无 bash 时的 `bash` 都属「平台不存在」，
 * 留在集合里只会让模型拿到一个每次调用都报错的工具。
 */
export function filterShellTools(
	tools: string[],
	resolution: PiShellResolution,
	platform: NodeJS.Platform,
): string[] {	return tools.filter((tool) => {
		if (tool === "bash") return resolution.bash !== null;
		if (tool === "powershell") {
			return platform === "win32" && resolution.powershell !== null;
		}
		return true;
	});
}
