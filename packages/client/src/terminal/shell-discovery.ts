import type { TerminalShellInfo } from "@vcpdeck/shared";
import { basename } from "node:path";

/** Shell 注册项：内部含 executable/args，公开 DTO 不含路径。 */
export interface ShellRegistryEntry {
	id: string;
	label: string;
	kind: "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "sh" | "other";
	executable: string;
	args: string[];
	isDefault: boolean;
}

/** Shell 探测环境抽象（测试注入）。 */
export interface ShellDiscoveryEnv {
	platform: NodeJS.Platform;
	home: string;
	/** $SHELL 环境变量值（可能不存在） */
	shellEnv: string | undefined;
	path: string;
	pathExt: string;
	/** 在 PATH 中解析可执行文件（返回绝对路径或 null）。 */
	resolveExecutable: (name: string) => Promise<string | null>;
	/** 检查文件是否存在且可执行。 */
	isExecutable: (path: string) => Promise<boolean>;
}

const WIN32_ORDER: Array<{
	name: string;
	kind: ShellRegistryEntry["kind"];
	args: string[];
}> = [
	{ name: "pwsh", kind: "pwsh", args: ["-NoLogo"] },
	{ name: "powershell", kind: "powershell", args: ["-NoLogo"] },
	{ name: "cmd", kind: "cmd", args: ["/Q"] },
];

const POSIX_NAMES: Array<{ name: string; kind: ShellRegistryEntry["kind"] }> = [
	{ name: "bash", kind: "bash" },
	{ name: "zsh", kind: "zsh" },
	{ name: "sh", kind: "sh" },
];

function kindForExecutable(path: string): ShellRegistryEntry["kind"] {
	const name = basename(path).toLowerCase().replace(/\.exe$/, "");
	switch (name) {
		case "pwsh":
			return "pwsh";
		case "powershell":
			return "powershell";
		case "cmd":
			return "cmd";
		case "bash":
			return "bash";
		case "zsh":
			return "zsh";
		case "sh":
			return "sh";
		default:
			return "other";
	}
}

/**
 * 探测可用 Shell（Windows：pwsh → powershell → cmd；POSIX：$SHELL → bash → zsh → sh）。
 * 只返回实际可用项；第一个可用项为默认。按解析后的可执行路径去重。
 */
export async function discoverShells(env: ShellDiscoveryEnv): Promise<ShellRegistryEntry[]> {
	const entries: ShellRegistryEntry[] = [];
	const seen = new Set<string>();

	async function add(path: string | null, id: string, args: string[]): Promise<void> {
		if (!path || seen.has(path)) return;
		if (!(await env.isExecutable(path))) return;
		seen.add(path);
		entries.push({
			id,
			label: id,
			kind: kindForExecutable(path),
			executable: path,
			args,
			isDefault: false,
		});
	}

	if (env.platform === "win32") {
		for (const shell of WIN32_ORDER) {
			const resolved = await env.resolveExecutable(shell.name);
			await add(resolved, shell.name, shell.args);
		}
	} else {
		// $SHELL 可能是绝对路径或裸命令名
		const shellEnv = env.shellEnv?.trim();
		if (shellEnv) {
			if (shellEnv.includes("/")) {
				await add(shellEnv, basename(shellEnv).replace(/\.exe$/, ""), []);
			} else {
				const resolved = await env.resolveExecutable(shellEnv);
				await add(resolved, shellEnv, []);
			}
		}
		for (const shell of POSIX_NAMES) {
			const resolved = await env.resolveExecutable(shell.name);
			await add(resolved, shell.name, []);
		}
	}

	if (entries.length > 0) entries[0] = { ...entries[0], isDefault: true };
	return entries;
}

/** 映射为公开 Shell DTO（不含可执行文件路径与启动参数）。 */
export function toTerminalShellInfo(entry: ShellRegistryEntry): TerminalShellInfo {
	return {
		id: entry.id,
		label: entry.label,
		kind: entry.kind,
		isDefault: entry.isDefault,
	};
}
