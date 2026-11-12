/**
 * Launcher 两阶段更新执行器（详见 docs/design/release-and-update.md）。
 * - prepare：下载 → sha256 校验 → 解压 → 清单验签 → 内容寻址组装（服务进程仍在运行）
 * - apply：停旧进程 → 切换 current → 启动 → 探活 → 失败自动回退旧版本
 *
 * 迁移期双路径：带 <清单>.sig 的包走新格式验签与硬链接组装；无签名的历史包
 * 与 e2e 夹具走目录直通。签名公钥经 VCPDECK_RELEASE_PUBLIC_KEY_PEM 注入，
 * 内置值为不对应任何私钥的占位公钥，故无签名包不可走验签路径。
 */
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONTROL_PROTOCOL_VERSION,
	ReleaseArtifactErrorCode,
	parseReleaseDeltaManifest,
	parseReleaseFileEntry,
	type ReleaseArtifactKind,
	type ReleaseDeltaCandidate,
	type ReleaseDeltaManifest,
	type ReleaseFileEntry,
	type UpdateManifest,
} from "@vcpdeck/shared";
import {
	assembleRelease,
	assertSafeExtractedTree,
	verifyManifestSignature,
} from "./assemble.js";
import { loadTrustedPublicKeyPem } from "./trusted-key.js";
import type { VersionStore } from "./versions.js";

export interface UpdaterDeps {
	versions: VersionStore;
	artifact: "server" | "client";
	/** 下载 zip 到目标路径 */
	downloadZip(url: string, destPath: string): Promise<void>;
	/** 流式 sha256 校验 */
	verifySha256(filePath: string, expected: string): Promise<boolean>;
	/** 解压 zip 到目标目录 */
	extractZip(zipPath: string, destDir: string): Promise<void>;
	/** 停止当前被守护进程 */
	stopProcess(): Promise<void>;
	/** 启动 current 版本进程 */
	startProcess(): Promise<unknown>;
	/** 健康探活（服务端：GET /api/status；客户端：进程存活） */
	probe(version: string): Promise<boolean>;
	/** 成功切换后的尽力记录钩子；失败不得影响已经健康的版本 */
	onSuccessfulApply?: (version: string, previous: string | null) => Promise<void>;
	probeRetries?: number;
	probeIntervalMs?: number;
}

const DEFAULT_PROBE_RETRIES = 3;
const DEFAULT_PROBE_INTERVAL_MS = 2000;

type ReleaseCode =
	(typeof ReleaseArtifactErrorCode)[keyof typeof ReleaseArtifactErrorCode];

const RELEASE_CODES = new Set<string>(
	Object.values(ReleaseArtifactErrorCode),
);

/** 携带稳定错误码的准备异常；message 不含堆栈、URL、密钥或文件内容。 */
class PrepareError extends Error {
	readonly code: ReleaseCode;

	constructor(code: ReleaseCode, message: string) {
		super(message);
		this.name = "PrepareError";
		this.code = code;
	}
}

/** 仅「组装失败」可降级 full；用它把组装异常与其它失败区分开。 */
class DeltaAssembleFailure extends Error {
	readonly code: ReleaseCode;

	constructor(err: unknown) {
		super("发布构件组装失败");
		this.name = "DeltaAssembleFailure";
		const raw = (err as { code?: unknown })?.code;
		this.code =
			typeof raw === "string" && RELEASE_CODES.has(raw)
				? (raw as ReleaseCode)
				: ReleaseArtifactErrorCode.ASSEMBLE_FAILED;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 距给定起点经过的秒数（一位小数） */
function secs(from: number): string {
	return `${((Date.now() - from) / 1000).toFixed(1)}s`;
}

/** zip 体积（MB，一位小数）；不可得时返回 null */
async function fileSizeMB(path: string): Promise<string | null> {
	try {
		const s = await stat(path);
		return (s.size / 1024 / 1024).toFixed(1);
	} catch {
		return null;
	}
}

interface PrepareAttempt {
	version: string;
	kind: ReleaseArtifactKind;
	url: string;
	sha256: string;
}

export class Updater {
	constructor(private readonly deps: UpdaterDeps) {}

	/**
	 * 第一阶段：准备新版本（完整版本目录幂等跳过）。
	 *
	 * 有可用基线时先尝试候选 delta 包；仅组装失败（含基线不可用、hash 不符）
	 * 时恰好降级 full 一次。验签失败、清单解析失败、sha256 不匹配均直接抛出，
	 * 不降级，避免用未经验证的 full 包掩盖信任边界问题。
	 */
	async prepare(input: {
		url: string;
		sha256: string;
		version: string;
		candidates?: ReleaseDeltaCandidate[];
	}): Promise<void> {
		if (await this.deps.versions.isPrepared(input.version, this.deps.artifact)) {
			return;
		}
		await this.deps.versions.removeVersion(input.version);

		const candidate = input.candidates?.find(
			(c) =>
				c.fromVersion !== input.version && this.baselineAvailable(c.fromVersion),
		);
		const startedAt = Date.now();
		if (candidate) {
			try {
				await this.prepareOnce({
					version: input.version,
					kind: "delta",
					url: candidate.url,
					sha256: candidate.sha256,
				});
			} catch (err) {
				if (!(err instanceof DeltaAssembleFailure)) throw err;
				await this.deps.versions.removeVersion(input.version);
				await this.prepareOnce({
					version: input.version,
					kind: "full",
					url: input.url,
					sha256: input.sha256,
				});
			}
		} else {
			await this.prepareOnce({
				version: input.version,
				kind: "full",
				url: input.url,
				sha256: input.sha256,
			});
		}
		console.log(`[launcher] prepare ${input.version} 总耗时: ${secs(startedAt)}`);
	}

	/** 单次下载 → 校验 → 解压 → 验签 → 组装；zip 与解压目录在 finally 清理。 */
	private async prepareOnce(opts: PrepareAttempt): Promise<void> {
		const tag = randomUUID();
		const zipPath = join(
			tmpdir(),
			`vcpdeck-${opts.version}-${opts.kind}-${tag}.zip`,
		);
		const extractedDir = join(
			tmpdir(),
			`vcpdeck-${opts.version}-${opts.kind}-${tag}`,
		);
		const targetDir = this.deps.versions.versionDir(opts.version);
		try {
			let phaseStart = Date.now();
			await this.deps.downloadZip(opts.url, zipPath);
			const sizeMB = await fileSizeMB(zipPath);
			console.log(
				`[launcher] prepare ${opts.version} 下载完成: ${secs(phaseStart)}${sizeMB ? `，${sizeMB}MB` : ""}`,
			);

			phaseStart = Date.now();
			const ok = await this.deps.verifySha256(zipPath, opts.sha256);
			if (!ok) throw new Error(`sha256 校验失败: ${opts.version}`);
			console.log(`[launcher] prepare ${opts.version} 校验通过: ${secs(phaseStart)}`);

			phaseStart = Date.now();
			await this.deps.extractZip(zipPath, extractedDir);
			console.log(`[launcher] prepare ${opts.version} 解压完成: ${secs(phaseStart)}`);

			const manifestName =
				opts.kind === "delta" ? "delta.json" : "manifest.json";
			const manifestPath = join(extractedDir, manifestName);
			const sigPath = `${manifestPath}.sig`;
			if (!existsSync(manifestPath) || !existsSync(sigPath)) {
				// 旧格式（无签名）直通：迁移期兼容历史包与 e2e 夹具。
				cpSync(extractedDir, targetDir, { recursive: true, force: true });
				return;
			}

			const manifest = this.readManifestObject(manifestPath);
			if (
				manifest.version !== opts.version ||
				manifest.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
				!Array.isArray(manifest.files)
			) {
				throw new PrepareError(
					ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
					"发布清单字段不完整",
				);
			}

			let files: ReleaseFileEntry[];
			let fromVersion: string | null;
			if (opts.kind === "delta") {
				let parsed: ReleaseDeltaManifest;
				try {
					parsed = parseReleaseDeltaManifest(manifest);
				} catch {
					throw new PrepareError(
						ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
						"增量清单校验失败",
					);
				}
				files = parsed.files;
				fromVersion = parsed.fromVersion;
			} else {
				try {
					files = manifest.files.map((entry) => parseReleaseFileEntry(entry));
				} catch {
					throw new PrepareError(
						ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
						"文件清单校验失败",
					);
				}
				fromVersion = null;
			}

			const signature = readFileSync(sigPath, "utf8").trim();
			if (
				!verifyManifestSignature(
					manifest,
					signature,
					loadTrustedPublicKeyPem(),
				)
			) {
				throw new PrepareError(
					ReleaseArtifactErrorCode.MANIFEST_SIGNATURE_INVALID,
					"发布清单签名无效",
				);
			}

			// full 清单不在自身 files[] 中，且 assemble 的元数据白名单不认它；
			// 内容已读入内存，先移出解压目录再预检，组装后显式写回 targetDir。
			if (opts.kind === "full") {
				await rm(manifestPath, { force: true });
			}
			assertSafeExtractedTree(extractedDir, files);

			const baselineDir =
				fromVersion !== null
					? this.deps.versions.versionDir(fromVersion)
					: null;
			try {
				await assembleRelease({ extractedDir, targetDir, baselineDir, files });
			} catch (err) {
				throw new DeltaAssembleFailure(err);
			}

			const targetManifest =
				opts.kind === "delta"
					? this.buildDeltaTargetManifest(fromVersion as string, opts.version)
					: manifest;
			writeFileSync(
				join(targetDir, "manifest.json"),
				JSON.stringify(targetManifest),
			);
		} finally {
			await rm(zipPath, { force: true }).catch(() => undefined);
			await rm(extractedDir, { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
	}

	/** 读取并浅校验清单对象；缺失/损坏统一为 RELEASE_ARTIFACTS_INCOMPLETE。 */
	private readManifestObject(path: string): Record<string, unknown> {
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				throw new Error("清单不是对象");
			}
			return value as Record<string, unknown>;
		} catch {
			throw new PrepareError(
				ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
				"发布清单缺失或损坏",
			);
		}
	}

	/** 基线版本目录需带可用 manifest.json，否则不派发 delta 包。 */
	private baselineAvailable(fromVersion: string): boolean {
		try {
			const raw = readFileSync(
				join(this.deps.versions.versionDir(fromVersion), "manifest.json"),
				"utf8",
			);
			return Boolean((JSON.parse(raw) as { artifacts?: unknown }).artifacts);
		} catch {
			return false;
		}
	}

	/**
	 * delta.json 严格五键不含 artifacts，而 isPrepared/applyUpdate 依赖 artifacts，
	 * 因此目标目录清单以基线清单为底，仅覆盖 version 与协议/种类标记。
	 */
	private buildDeltaTargetManifest(
		fromVersion: string,
		version: string,
	): UpdateManifest {
		let baseline: UpdateManifest;
		try {
			baseline = JSON.parse(
				readFileSync(
					join(this.deps.versions.versionDir(fromVersion), "manifest.json"),
					"utf8",
				),
			) as UpdateManifest;
		} catch {
			throw new PrepareError(
				ReleaseArtifactErrorCode.DELTA_BASELINE_UNAVAILABLE,
				"基线清单不可用",
			);
		}
		if (!baseline.artifacts) {
			throw new PrepareError(
				ReleaseArtifactErrorCode.DELTA_BASELINE_UNAVAILABLE,
				"基线清单缺少 artifacts",
			);
		}
		return {
			...baseline,
			version,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			kind: "delta",
		};
	}

	/** 第二阶段：切换并启动新版本；探活失败自动回退 */
	async apply(version: string): Promise<void> {
		const previous = await this.deps.versions.currentVersion();
		await this.deps.stopProcess();
		await this.deps.versions.switchTo(version);
		await this.deps.startProcess();

		const healthy = await this.probeWithRetry(version);
		if (healthy) {
			if (this.deps.onSuccessfulApply) {
				try {
					await this.deps.onSuccessfulApply(version, previous);
				} catch {
					console.warn("[launcher] 版本保留记录失败，继续使用已切换版本");
				}
			}
			return;
		}

		if (previous) {
			await this.deps.stopProcess();
			await this.deps.versions.switchTo(previous);
			await this.deps.startProcess();
		}
		throw new Error(
			previous
				? `版本 ${version} 健康检查失败，已回退 ${previous}`
				: `版本 ${version} 健康检查失败`,
		);
	}

	private async probeWithRetry(version: string): Promise<boolean> {
		const retries = this.deps.probeRetries ?? DEFAULT_PROBE_RETRIES;
		const interval = this.deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
		for (let i = 0; i < retries; i++) {
			if (await this.deps.probe(version)) return true;
			if (i < retries - 1) await sleep(interval);
		}
		return false;
	}
}
