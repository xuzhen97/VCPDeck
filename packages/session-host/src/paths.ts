import path from "node:path";

/** 会话宿主使用的稳定目录集合。 */
export interface SessionHostPaths {
	root: string;
	stateDir: string;
	runDir: string;
	logDir: string;
}

/**
 * 解析会话宿主的稳定目录。
 *
 * 范围限定 Windows 与 Linux；其他平台直接拒绝，不猜测目录布局。
 * 目录不由版本号派生，因此不会随 Release 切换而改变。
 */
export function resolveSessionHostPaths(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): SessionHostPaths {
	if (platform === "win32") {
		const base = env.ProgramData ?? env.ALLUSERSPROFILE;
		if (!base) throw new Error("无法确定 Windows 稳定目录：ProgramData 与 ALLUSERSPROFILE 均缺失");
		return withRoot(path.win32.join(base, "VCPDeck", "session-host"), path.win32);
	}
	if (platform === "linux") {
		return withRoot("/var/lib/vcpdeck/session-host", path.posix);
	}
	throw new Error(`会话宿主不支持该平台：${platform}（仅支持 Windows 与 Linux）`);
}

// 路径拼接必须跟随传入平台，不能跟随宿主进程所在平台。
type PathFlavor = Pick<typeof path.win32, "join">;

function withRoot(root: string, flavor: PathFlavor): SessionHostPaths {
	return {
		root,
		stateDir: flavor.join(root, "state"),
		runDir: flavor.join(root, "run"),
		logDir: flavor.join(root, "log"),
	};
}

/** 顺序创建目录，已存在不视为错误。 */
export async function ensureSessionHostPaths(
	paths: SessionHostPaths,
	mkdir: (target: string, options: { recursive: true }) => Promise<unknown> = (t, o) => import("node:fs/promises").then((fs) => fs.mkdir(t, o)),
): Promise<void> {
	for (const dir of [paths.root, paths.stateDir, paths.runDir, paths.logDir]) {
		await mkdir(dir, { recursive: true });
	}
}
