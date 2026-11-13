/**
 * Tailnet 只读探测（ADR-0062）。
 *
 * 探测只读取 backend 状态与本机标识，绝不读取 peer 列表，也绝不
 * 启动、修复或升级 Tailscale。任何异常都必须降级为 unknown。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { win32 } from "node:path";
import type { TailnetErrorCode, TailnetSnapshot } from "@vcpdeck/shared";

/** 单次只读命令的输出上限，防止异常输出撑爆内存。 */
const MAX_PROBE_BYTES = 1024 * 1024;

/** 只读命令超时。 */
const PROBE_TIMEOUT_MS = 5_000;

/** 一条只读命令的结果。 */
export interface TailnetCommandResult {
	ok: boolean;
	stdout: string;
	/** 二进制不存在。 */
	missing?: boolean;
	/** 命令超时。 */
	timedOut?: boolean;
	/** 输出超过上限。 */
	outputTooLarge?: boolean;
}

/** 可注入的只读命令执行器。 */
export type TailnetCommandRunner = (
	args: string[],
) => Promise<TailnetCommandResult>;

/** 探测依赖；测试全部注入。 */
export interface TailnetProbeDeps {
	run: TailnetCommandRunner;
	now: () => string;
}

function runBinary(
	command: string,
	args: string[],
): Promise<TailnetCommandResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				timeout: PROBE_TIMEOUT_MS,
				maxBuffer: MAX_PROBE_BYTES,
				windowsHide: true,
			},
			(error, stdout) => {
				if (!error) {
					resolve({ ok: true, stdout: String(stdout ?? "") });
					return;
				}
				const code = (error as NodeJS.ErrnoException).code;
				resolve({
					ok: false,
					stdout: String(stdout ?? ""),
					missing: code === "ENOENT",
					timedOut:
						error.killed === true ||
						code === "ETIMEDOUT" ||
						code === "ABORT_ERR",
					outputTooLarge:
						code === "ENOBUFS" || /maxBuffer/i.test(error.message),
				});
			},
		);
	});
}

/**
 * PATH 未刷新时的可执行文件兜底位置。
 *
 * 安装器成功后只更新系统 PATH（Windows 落在注册表），而已经运行的 client
 * 进程仍持有启动时的环境快照，裸名调用会一直 ENOENT。这里给出各平台的
 * 已知安装位置，仅在裸名解析失败后回退，不改变 PATH 优先的既有行为。
 */
export function fallbackBinaryCandidates(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (platform === "win32") {
		const programFiles = env.ProgramFiles ?? "C:\\Program Files";
		return [win32.join(programFiles, "Tailscale", "tailscale.exe")];
	}
	return ["/usr/local/bin/tailscale", "/usr/bin/tailscale"];
}

/** 首个真实存在的兜底路径；每次重新检查，安装后同进程内也能解析到。 */
function existingBinary(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	for (const candidate of fallbackBinaryCandidates(platform, env)) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * 解析 tailscale 可执行文件。
 *
 * 已知安装位置存在时返回绝对路径（`tailscale up` 等写操作同样受
 * 「PATH 未刷新」影响），否则退回裸名交给 PATH 解析。
 */
export function resolveTailscaleBinary(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return existingBinary(platform, env) ?? "tailscale";
}

/**
 * 执行只读探测命令。
 *
 * 先按 PATH 用裸名调用；只有 ENOENT（命令不存在）才回退到已知安装位置。
 * 其余失败（超时、非 0 退出、输出超限）原样返回，不做第二次尝试。
 */
async function defaultRun(args: string[]): Promise<TailnetCommandResult> {
	const primary = await runBinary("tailscale", args);
	if (!primary.missing) {
		return primary;
	}
	const fallback = existingBinary();
	if (fallback === null) {
		return primary;
	}
	return runBinary(fallback, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapBackendState(raw: unknown): TailnetSnapshot["backend"] {
	switch (raw) {
		case "Running":
			return "running";
		case "NeedsLogin":
			return "needs-login";
		case "NeedsMachineAuth":
			return "needs-approval";
		case "Stopped":
			return "stopped";
		default:
			return "unknown";
	}
}

function readNodeName(raw: unknown): string | null {
	if (typeof raw !== "string") {
		return null;
	}
	const name = raw.endsWith(".") ? raw.slice(0, -1) : raw;
	if (!name || name.length > 253) {
		return null;
	}
	return /^[\w.-]+$/.test(name) ? name : null;
}

function readAddresses(raw: unknown): { ipv4: string[]; ipv6: string[] } {
	const ipv4: string[] = [];
	const ipv6: string[] = [];
	if (!Array.isArray(raw)) {
		return { ipv4, ipv6 };
	}
	for (const value of raw) {
		if (typeof value !== "string") {
			continue;
		}
		const family = isIP(value);
		if (family === 4 && ipv4.length < 16) {
			ipv4.push(value);
		} else if (family === 6 && ipv6.length < 16) {
			ipv6.push(value);
		}
	}
	return { ipv4, ipv6 };
}

/**
 * 把 `tailscale status --json` 的原始输入投影为受限摘要。
 *
 * 只读取 `BackendState` 与 `Self`，其余字段（尤其 `Peer`）绝不进入结果。
 */
export function projectTailnetStatus(
	raw: unknown,
	observedAt: string,
): TailnetSnapshot {
	const input = isRecord(raw) ? raw : {};
	const self = isRecord(input.Self) ? input.Self : {};
	const { ipv4, ipv6 } = readAddresses(self.TailscaleIPs);
	return {
		installed: "yes",
		version: null,
		service: "running",
		backend: mapBackendState(input.BackendState),
		nodeName: readNodeName(self.DNSName),
		ipv4,
		ipv6,
		observedAt,
		errorCode: null,
	};
}

function emptySnapshot(
	observedAt: string,
	overrides: Partial<TailnetSnapshot>,
): TailnetSnapshot {
	return {
		installed: "unknown",
		version: null,
		service: "unknown",
		backend: "unknown",
		nodeName: null,
		ipv4: [],
		ipv6: [],
		observedAt,
		errorCode: null,
		...overrides,
	};
}

function parseVersion(raw: string): string | null {
	const line = (raw.split(/\r?\n/)[0] ?? "").trim();
	if (!line || line.length > 100 || /[\r\n\0]/.test(line)) {
		return null;
	}
	return line;
}

function codeFor(result: TailnetCommandResult): TailnetErrorCode {
	if (result.timedOut) {
		return "TAILNET_PROBE_TIMEOUT";
	}
	return "TAILNET_CLI_FAILED";
}

/**
 * 只读探测本机 Tailscale 状态。
 *
 * 不启动服务、不安装、不读取 peers；无法判定的字段一律 unknown。
 */
export async function probeTailnet(
	deps: Partial<TailnetProbeDeps> = {},
): Promise<TailnetSnapshot> {
	const run = deps.run ?? defaultRun;
	const now = deps.now ?? (() => new Date().toISOString());
	const observedAt = now();

	const versionResult = await run(["version"]);
	if (!versionResult.ok) {
		return emptySnapshot(observedAt, {
			installed: versionResult.missing ? "no" : "unknown",
			errorCode: versionResult.missing
				? "TAILNET_CLI_MISSING"
				: codeFor(versionResult),
		});
	}
	const version = parseVersion(versionResult.stdout);

	const statusResult = await run(["status", "--json", "--peers=false"]);
	if (!statusResult.ok) {
		return emptySnapshot(observedAt, {
			installed: "yes",
			version,
			service: statusResult.timedOut ? "unknown" : "stopped",
			errorCode: codeFor(statusResult),
		});
	}
	if (statusResult.outputTooLarge) {
		return emptySnapshot(observedAt, {
			installed: "yes",
			version,
			errorCode: "TAILNET_CLI_FAILED",
		});
	}

	let raw: unknown;
	try {
		raw = JSON.parse(statusResult.stdout);
	} catch {
		return emptySnapshot(observedAt, {
			installed: "yes",
			version,
			errorCode: "TAILNET_CLI_FAILED",
		});
	}

	return {
		...projectTailnetStatus(raw, observedAt),
		installed: "yes",
		version,
		service: "running",
	};
}
