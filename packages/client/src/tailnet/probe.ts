/**
 * Tailnet 只读探测（ADR-0062）。
 *
 * 探测只读取 backend 状态与本机标识，绝不读取 peer 列表，也绝不
 * 启动、修复或升级 Tailscale。任何异常都必须降级为 unknown。
 */
import { execFile } from "node:child_process";
import { isIP } from "node:net";
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

function defaultRun(args: string[]): Promise<TailnetCommandResult> {
	return new Promise((resolve) => {
		execFile(
			"tailscale",
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
