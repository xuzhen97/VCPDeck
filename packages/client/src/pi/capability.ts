import { access, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { fork } from "node:child_process";
import type { PiCapabilityStatus } from "@vcpdeck/shared";
import { isSupportedNodeVersion } from "./node-version.js";

/** probe-worker 的结果（不含路径/凭据） */
export interface ProbeWorkerResult {
	sdkVersion: string;
	modelCount: number;
	error: { code: "PI_RUNTIME_UNAVAILABLE" | "PI_AUTH_UNAVAILABLE"; message: string } | null;
}

/** 探测环境抽象（测试注入） */
export interface ProbeEnv {
	nodeVersion: string;
	platform: NodeJS.Platform;
	homedir: string;
	readSettingsShellPath: () => Promise<string | null>;
	existsGitBash: () => Promise<boolean>;
	findBashInPath: () => Promise<boolean>;
	forkProbeWorker: () => Promise<ProbeWorkerResult>;
	readAgentDir: () => Promise<boolean>;
}

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

async function exists(p: string): Promise<boolean> {
	return access(p).then(
		() => true,
		() => false,
	);
}

/**
 * 读取 ~/.pi/agent/settings.json 的 shellPath（Windows 探测第一来源）。
 * 只返回是否配置，不返回真实路径。
 */
async function readSettingsShellPath(home: string): Promise<string | null> {
	try {
		const raw = await readFile(join(home, ".pi", "agent", "settings.json"), "utf8");
		const parsed = JSON.parse(raw) as { shellPath?: unknown };
		return typeof parsed.shellPath === "string" && parsed.shellPath.length > 0
			? parsed.shellPath
			: null;
	} catch {
		return null;
	}
}

/**
 * 在 PATH 中查找 bash（跨平台：Windows 找 bash.exe，POSIX 找 bash）。
 * PATH 分隔符使用 path.delimiter（Windows `;`、Linux/macOS `:`）。
 */
async function findBashInPath(): Promise<boolean> {
	const isWin = platform() === "win32";
	const name = isWin ? "bash.exe" : "bash";
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		if (await exists(join(dir, name))) return true;
	}
	return false;
}

/** 生成真实探测环境（生产路径） */
export function createProbeEnv(): ProbeEnv {
	const home = homedir();
	return {
		nodeVersion: process.versions.node,
		platform: platform(),
		homedir: home,
		readSettingsShellPath: () => readSettingsShellPath(home),
		existsGitBash: () => exists(GIT_BASH),
		findBashInPath,
		forkProbeWorker: () => forkProbeWorkerOnce(),
		readAgentDir: () => {
			const dir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
			return exists(dir);
		},
	};
}

let probeWorkerPromise: Promise<ProbeWorkerResult> | null = null;

/** fork 探测 Worker 并收集结果（进程内缓存） */
export function forkProbeWorkerOnce(): Promise<ProbeWorkerResult> {
	if (!probeWorkerPromise) {
		probeWorkerPromise = forkProbeWorker();
	}
	return probeWorkerPromise;
}

function forkProbeWorker(): Promise<ProbeWorkerResult> {
	return new Promise((resolve) => {
		const child = fork(join(__dirname, "probe-worker.js"), {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const timer = setTimeout(() => {
			child.kill();
			resolve({
				sdkVersion: "",
				modelCount: 0,
				error: {
					code: "PI_RUNTIME_UNAVAILABLE",
					message: "Pi probe worker timed out",
				},
			});
		}, 15_000);

		child.on("message", (msg: unknown) => {
			const m = msg as Partial<ProbeWorkerResult>;
			if (typeof m?.sdkVersion !== "string") return;
			clearTimeout(timer);
			child.disconnect();
			resolve({
				sdkVersion: m.sdkVersion,
				modelCount: typeof m.modelCount === "number" ? m.modelCount : 0,
				error: m.error ?? null,
			});
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({
				sdkVersion: "",
				modelCount: 0,
				error: {
					code: "PI_RUNTIME_UNAVAILABLE",
					message: "Pi probe worker failed to start",
				},
			});
		});
		child.on("exit", () => {
			clearTimeout(timer);
		});
	});
}

/**
 * 轻量能力探测：Node 版本 → Bash（Windows 按 Pi 官方顺序）→ Agent 目录 → SDK Worker。
 * 探测失败只禁用 Pi 功能，不影响 exec/files/FRP。结果不含路径与凭据。
 */
export async function probePiCapability(
	env: ProbeEnv = createProbeEnv(),
): Promise<PiCapabilityStatus> {
	if (!isSupportedNodeVersion(env.nodeVersion)) {
		return {
			available: false,
			code: "PI_NODE_UNSUPPORTED",
			message: `Pi requires Node >= 22.19.0, found ${env.nodeVersion}`,
			nodeVersion: env.nodeVersion,
		};
	}

	let shellKind: "configured" | "git-bash" | "path" | "system" = "system";
	if (env.platform === "win32") {
		const configured = await env.readSettingsShellPath();
		if (configured) shellKind = "configured";
		else if (await env.existsGitBash()) shellKind = "git-bash";
		else if (await env.findBashInPath()) shellKind = "path";
		else {
			return {
				available: false,
				code: "PI_BASH_NOT_FOUND",
				message: "Pi-compatible Bash not found on Windows",
			};
		}
	} else if (!(await env.findBashInPath())) {
		// Linux/macOS：Pi 同样需要 bash（bash 不在 PATH 时降级）
		return {
			available: false,
			code: "PI_BASH_NOT_FOUND",
			message: "Bash not found in PATH",
		};
	}

	if (!(await env.readAgentDir())) {
		return {
			available: false,
			code: "PI_RUNTIME_UNAVAILABLE",
			message: "Pi agent directory is not readable",
		};
	}

	const worker = await env.forkProbeWorker();
	if (worker.error) {
		return { available: false, code: worker.error.code, message: worker.error.message };
	}
	if (worker.modelCount === 0) {
		return {
			available: false,
			code: "PI_AUTH_UNAVAILABLE",
			message: "Remote Pi has no authenticated model",
			nodeVersion: env.nodeVersion,
		};
	}
	return {
		available: true,
		sdkVersion: worker.sdkVersion,
		nodeVersion: env.nodeVersion,
		shellKind,
	};
}
