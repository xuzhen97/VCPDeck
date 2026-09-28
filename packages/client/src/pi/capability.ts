import { platform } from "node:os";
import { join } from "node:path";
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
import {
	createPiShellEnv,
	resolvePiShells,
	type PiShellResolution,
} from "./shell.js";

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
	/** 解析本机可用 shell（绝对路径优先）。缺 bash 不算失败，见 shell.ts。 */
	resolveShells: () => Promise<PiShellResolution>;
	forkProbeWorker: () => Promise<ProbeWorkerResult>;
	/** VCPDeck Pi 数据根是否可写；不可写时 Pi 不可用，不回退用户 Pi。 */
	ensureDataRootWritable: () => Promise<boolean>;
	/** 定位并校验随 Release 发布的 Bundle；无可用 Bundle 时返回 null。 */
	resolveBundle: (sdkVersion: string) => Promise<VerifiedPiBundle | null>;
}

/** 生成真实探测环境（生产路径） */
export function createProbeEnv(): ProbeEnv {
	return {
		nodeVersion: process.versions.node,
		platform: platform(),
		resolveShells: () => resolvePiShells(createPiShellEnv()),
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

/**
 * fork 探测 Worker 并收集结果（仅缓存成功）。
 *
 * **失败不缓存**：进程内缓存一次失败会把一次性抖动（磁盘/杀软首开慢）放大成整个
 * Client 生命周期的「Pi 不支持」，且只能靠重启进程恢复（实测事故见 syc 机器）。
 */
export function forkProbeWorkerOnce(): Promise<ProbeWorkerResult> {
	if (!probeWorkerPromise) {
		probeWorkerPromise = forkProbeWorker().then((result) => {
			if (result.error) probeWorkerPromise = null;
			return result;
		});
	}
	return probeWorkerPromise;
}

/**
 * Worker 上限。Release 里 Pi SDK 是**单文件**产物（见 scripts/bundle-apps.ts `bundlePiSdk`），
 * 加载只付一次文件打开 + 解析（实测 ≈0.5s，未打包时要按 2,400 次文件打开计），
 * 因此这个上限只用于兜住「卡死」，不再承担「首开慢」的代价。
 * 实测事故：未打包时某机器每次文件首次打开 19.6ms，冷加载 47.8s，稳定超过限额被误判为不支持。
 */
export const PROBE_WORKER_TIMEOUT_MS = 15_000;

function forkProbeWorker(): Promise<ProbeWorkerResult> {
	return new Promise((resolve) => {
		let settled = false;
		const fail = (message: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				sdkVersion: "",
				providerIds: [],
				error: { code: "PI_RUNTIME_UNAVAILABLE", message },
			});
		};
		const child = fork(join(__dirname, "probe-worker.js"), {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		child.send({ type: "probe" });
		const timer = setTimeout(() => {
			child.kill();
			fail("Pi probe worker timed out");
		}, PROBE_WORKER_TIMEOUT_MS);

		child.on("message", (msg: unknown) => {
			const m = msg as Partial<ProbeWorkerResult>;
			if (typeof m?.sdkVersion !== "string") return;
			if (settled) return;
			settled = true;
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
		child.on("error", (err) => {
			fail(
				`Pi probe worker failed to start: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		// 子进程静默退出（import 抛错、缺依赖、OOM）必须显式收敛：只 clearTimeout 会让
		// 崩溃伪装成 30s 超时，无法与「加载慢」区分（实测事故的根因之一）。
		child.on("exit", (code) => {
			fail(`Pi probe worker exited before reporting (code=${code ?? "null"})`);
		});
	});
}

/**
 * 轻量能力探测：Node 版本 → shell 解析 → VCPDeck data root 可写 → SDK 加载与版本。
 *
 * 探测失败只禁用 Pi 功能，不影响 exec/files/FRP。结果不含路径与凭据。
 *
 * 注意「缺 bash」**不是**失败原因：它只影响 bash 工具是否可用（见 shell.ts）。
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

	// shell 只影响「哪些 shell 工具可用」，不再是整机门禁：
	// Windows 上 Pi 的 PowerShell 工具是并列的一等能力，缺 Git Bash 完全可用
	//（SDK 的 POSIX 分支在无 bash 时还会退到 `sh`）。缺 bash 的机器以前会被整机禁用。
	const shells = await env.resolveShells();
	const shellKind: "configured" | "git-bash" | "path" | "system" =
		shells.bashSource ?? "system";

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
