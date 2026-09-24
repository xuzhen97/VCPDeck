import { access } from "node:fs/promises";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { fork } from "node:child_process";
import {
	PI_RUNTIME_SPEC_PROTOCOL_VERSION,
	PI_SESSION_JOB_PROTOCOL_VERSION,
	type PiCapabilityStatus,
} from "@vcpdeck/shared";
import { isSupportedNodeVersion } from "./node-version.js";
import {
	ensureVcpPiRuntimeDirs,
	resolveVcpPiRuntimePaths,
} from "./runtime-paths.js";
import { resolveVerifiedPiBundle, type VerifiedPiBundle } from "./bundle.js";

/** probe-worker 的结果（不含路径/凭据） */
export interface ProbeWorkerResult {
	sdkVersion: string;
	/** SDK 内置目录的 Provider ID（已去重）；探测失败或旧 Worker 可能为空。 */
	providerIds: string[];
	error: {
		code: "PI_RUNTIME_UNAVAILABLE";
		message: string;
	} | null;
}

/**
 * 探测环境抽象（测试注入）。
 *
 * 注意这里刻意没有「读用户 Pi」的能力：
 * 无 settings.json / auth.json / models.json / ProjectTrust 读取入口（设计 §9.4）。
 */
export interface ProbeEnv {
	nodeVersion: string;
	platform: NodeJS.Platform;
	existsGitBash: () => Promise<boolean>;
	findBashInPath: () => Promise<boolean>;
	forkProbeWorker: () => Promise<ProbeWorkerResult>;
	/** VCPDeck Pi 数据根是否可写；不可写时 Pi 不可用，不回退用户 Pi。 */
	ensureDataRootWritable: () => Promise<boolean>;
	/** 定位并校验随 Release 发布的 Bundle；无可用 Bundle 时返回 null。 */
	resolveBundle: (sdkVersion: string) => Promise<VerifiedPiBundle | null>;
}

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

async function exists(p: string): Promise<boolean> {
	return access(p).then(
		() => true,
		() => false,
	);
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
	return {
		nodeVersion: process.versions.node,
		platform: platform(),
		existsGitBash: () => exists(GIT_BASH),
		findBashInPath,
		forkProbeWorker: () => forkProbeWorkerOnce(),
		ensureDataRootWritable: async () => {
			try {
				await ensureVcpPiRuntimeDirs(resolveVcpPiRuntimePaths());
				return true;
			} catch {
				return false;
			}
		},
		resolveBundle: (sdkVersion) => resolveAndCacheBundle(sdkVersion),
	};
}

let bundleCache: {
	sdkVersion: string;
	bundle: VerifiedPiBundle | null;
} | null = null;

/**
 * 定位并校验 Bundle，并把结果缓存在进程内（能力上报与 RuntimeSpec 接纳共用同一份）。
 * Bundle 属于不可变版本目录，缓存一次即可；结果不写任何文件。
 */
async function resolveAndCacheBundle(
	sdkVersion: string,
): Promise<VerifiedPiBundle | null> {
	const bundle = await resolveVerifiedPiBundle({
		selfDir: __dirname,
		appDir: process.env.VCPDECK_APP_DIR ?? process.cwd(),
		sdkVersion,
	});
	bundleCache = { sdkVersion, bundle };
	return bundle;
}

/**
 * 读取已缓存的 Bundle 校验结果；未探测过时返回 null。
 *
 * 刻意不在此处触发探测：RuntimeSpec 接纳必须同步、无副作用（探测在 REGISTER 前已完成）。
 * 未探测到 Bundle 时按「无可用 Bundle」处理，需要资源的 Spec 会在二次校验中 fail closed。
 */
export function getCachedClientBundle(): {
	sdkVersion: string;
	bundle: VerifiedPiBundle | null;
} | null {
	return bundleCache;
}

/** 重置缓存（仅测试用）。 */
export function resetClientBundleCache(): void {
	bundleCache = null;
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
		child.send({ type: "probe" });
		const timer = setTimeout(() => {
			child.kill();
			resolve({
				sdkVersion: "",
				providerIds: [],
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
				providerIds: Array.isArray(m.providerIds)
					? m.providerIds.filter((id): id is string => typeof id === "string")
					: [],
				error: m.error ?? null,
			});
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({
				sdkVersion: "",
				providerIds: [],
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
 * 轻量能力探测：Node 版本 → Bash（Windows 按 Pi 官方顺序）→ VCPDeck data root 可写 → SDK 版本。
 *
 * 探测失败只禁用 Pi 功能，不影响 exec/files/FRP。结果不含路径与凭据。
 *
 * 本机「已认证模型」不再参与判定：模型可用性由 Server 下发的 RuntimeSpec 决定
 * （设计 §16）。`PI_AUTH_UNAVAILABLE` 仍保留在共享枚举中供旧 Client 上报。
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
		if (await env.existsGitBash()) shellKind = "git-bash";
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

	if (!(await env.ensureDataRootWritable())) {
		return {
			available: false,
			code: "PI_RUNTIME_UNAVAILABLE",
			message: "VCPDeck Pi data root is not writable",
		};
	}

	const worker = await env.forkProbeWorker();
	if (worker.error) {
		return {
			available: false,
			code: worker.error.code,
			message: worker.error.message,
		};
	}
	// Bundle 校验：失败（无 Bundle / manifest 非法 / 摘要不符 / SDK 版本不符）时不上报该字段。
	const bundle = worker.sdkVersion
		? await env.resolveBundle(worker.sdkVersion)
		: null;
	return {
		available: true,
		sdkVersion: worker.sdkVersion,
		nodeVersion: env.nodeVersion,
		shellKind,
		sessionJobProtocolVersion: PI_SESSION_JOB_PROTOCOL_VERSION,
		runtimeSpecProtocolVersion: PI_RUNTIME_SPEC_PROTOCOL_VERSION,
		configMode: "server-authoritative",
		...(worker.providerIds.length > 0
			? { modelCatalog: { sdkVersion: worker.sdkVersion, providerIds: worker.providerIds } }
			: {}),
		...(bundle
			? {
					bundle: {
						protocolVersion: bundle.manifest.protocolVersion,
						bundleVersion: bundle.manifest.bundleVersion,
						piSdkVersion: bundle.manifest.piSdkVersion,
						resourceIds: [...bundle.resourceIds],
					},
				}
			: {}),
	};
}
