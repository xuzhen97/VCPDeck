/**
 * VCPDeck Pi 运行时路径解析（唯一入口）。
 *
 * 目标：VCPDeck Pi 的 agentDir / sessions 必须落在 VCPDeck 自己的稳定数据根，
 * 与 Client 版本目录（`apps/<version>`）和用户原生 Pi（`~/.pi`）完全分离。
 *
 * dataRoot 解析顺序：
 *   1. `VCPDECK_CLIENT_DATA_DIR`（由安装器写入 env 文件，最高优先）
 *   2. `VCPDECK_APP_DIR/data`
 *   3. `<cwd>/data`
 *
 * 路径语义按 platform 选择 win32/posix，避免在非目标平台上生成错误分隔符
 * （同 scripts/install-client-linux.cjs 的做法）。
 */
import { mkdir } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { piError } from "./project-path.js";

/** VCPDeck Pi 全部运行时路径 */
export interface VcpPiRuntimePaths {
	dataRoot: string;
	piRoot: string;
	agentDir: string;
	sessionsRoot: string;
	installSecretPath: string;
	cacheDir: string;
	tmpDir: string;
	diagnosticsDir: string;
}

export interface VcpPiRuntimePathsInput {
	platform: NodeJS.Platform;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** 解析 VCPDeck Pi 运行时路径；结果绝不指向用户原生 Pi。 */
export function resolveVcpPiRuntimePaths(
	input: Partial<VcpPiRuntimePathsInput> = {},
): VcpPiRuntimePaths {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const cwd = input.cwd ?? process.cwd();
	const p = platform === "win32" ? win32 : posix;

	const appDir = env.VCPDECK_APP_DIR || cwd;
	const dataRoot = p.resolve(
		env.VCPDECK_CLIENT_DATA_DIR || p.join(appDir, "data"),
	);

	// 数据根必须在版本目录之外，否则 Release 切换/回滚会带走 Session。
	const releaseRoot = p.resolve(p.join(appDir, "apps"));
	const comparable = (value: string) =>
		platform === "win32" ? value.toLowerCase() : value;
	const root = comparable(dataRoot);
	const releases = comparable(releaseRoot);
	if (root === releases || root.startsWith(`${releases}${p.sep}`)) {
		throw piError("PI_CONFIG_UNAVAILABLE", "Pi data root 不得位于版本目录内");
	}

	const piRoot = p.join(dataRoot, "pi");
	return {
		dataRoot,
		piRoot,
		agentDir: p.join(piRoot, "agent"),
		sessionsRoot: p.join(piRoot, "sessions"),
		installSecretPath: p.join(piRoot, "install-secret"),
		cacheDir: p.join(piRoot, "cache"),
		tmpDir: p.join(piRoot, "tmp"),
		diagnosticsDir: p.join(piRoot, "diagnostics"),
	};
}

/**
 * 创建 Pi 运行时目录。不可写时 fail closed（Pi 不可用），
 * 绝不 fallback 到用户原生 Pi 目录。
 */
export async function ensureVcpPiRuntimeDirs(
	paths: VcpPiRuntimePaths,
): Promise<void> {
	for (const dir of [
		paths.agentDir,
		paths.sessionsRoot,
		paths.cacheDir,
		paths.tmpDir,
		paths.diagnosticsDir,
	]) {
		try {
			await mkdir(dir, { recursive: true });
		} catch {
			throw piError("PI_CONFIG_UNAVAILABLE", "Pi data root 不可写");
		}
	}
}
