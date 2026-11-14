/**
 * 守护进程编排（详见 docs/design/release-and-update.md）：
 * - ensure-node 保障运行时 → 启动 current 版本 → 崩溃退避拉起（更新期间抑制）
 * - 控制通道 /prepare、/apply → Updater 两阶段更新 + preStart 钩子 + 探活回退
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
	ReleaseArtifactErrorCode,
	type LauncherPrepareStatus,
	type MuslReleaseTarget,
	parseMuslReleaseTarget,
	type UpdateManifest,
} from "@vcpdeck/shared";
import { extractArchive } from "./archive.js";
import { ensureNodeRuntime } from "./ensure-node.js";
import { ensureMuslRuntime } from "./musl-runtime.js";
import { verifyManifestSignature } from "./assemble.js";
import { loadTrustedPublicKeyPem } from "./trusted-key.js";
import {
	readOwnedProcessFacts,
	reclaimOwnedProcess,
	writeOwnedLedger,
} from "./ownership.js";
import { VersionStore } from "./versions.js";
import { Updater } from "./updater.js";
import {
	createControlServer,
	runPreStart,
	type ControlHandlers,
} from "./control.js";
import { VersionRetention, type RetentionCleanupResult } from "./version-retention.js";

export interface DaemonConfig {
	/** launcher 应用目录（默认 ~/.vcpdeck/launcher） */
	appDir: string;
	/** 被守护构件：server | client */
	artifact: "server" | "client";
	/** server 探活 URL（默认 http://127.0.0.1:3001/api/status） */
	probeUrl?: string;
	log?: (msg: string) => void;
	/** 测试或宿主注入的本地版本保留器 */
	retention?: VersionRetentionLike;
}

export interface VersionRetentionLike {
	initialize(): Promise<void>;
	recordSuccessful(version: string): Promise<boolean>;
	cleanup(protectedVersions?: ReadonlySet<string>): Promise<RetentionCleanupResult>;
}

const MAX_CRASH_RETRIES = 5;
const STABLE_WINDOW_MS = 30_000;
/** client 探活稳定窗口：启动后至少存活此时长才判健康（秒退进程判失败） */
const CLIENT_PROBE_STABLE_MS = 3000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAYS_MS = [500, 1000];
const RETENTION_STARTUP_DELAY_MS = STABLE_WINDOW_MS;

const KNOWN_RELEASE_CODES = new Set<string>(
	Object.values(ReleaseArtifactErrorCode),
);

/** 只回报协议内稳定错误码，避免把原始异常文本写进状态或日志。 */
function safePrepareErrorCode(err: unknown): string {
	const raw = (err as { code?: unknown })?.code;
	return typeof raw === "string" && KNOWN_RELEASE_CODES.has(raw)
		? raw
		: ReleaseArtifactErrorCode.ASSEMBLE_FAILED;
}

function isTransientDownloadStatus(status: number): boolean {
	return status === 502 || status === 503 || status === 504;
}

/** 读取版本目录下的 manifest.json；缺失/损坏返回 null */
export function readManifest(versionDir: string): UpdateManifest | null {
	try {
		return JSON.parse(
			readFileSync(join(versionDir, "manifest.json"), "utf-8"),
		) as UpdateManifest;
	} catch {
		return null;
	}
}

/** 读取版本目录下的 musl 运行时描述；没有则说明是双平台 glibc 包。 */
export function readClientReleaseTarget(
	versionDir: string,
): MuslReleaseTarget | null {
	const path = join(versionDir, "client", "release-target.json");
	if (!existsSync(path)) return null;
	return parseMuslReleaseTarget(JSON.parse(readFileSync(path, "utf-8")));
}

/**
 * 本机 Launcher 运行时是否为 musl：仅 Linux 生效，且无法证明 glibc 时按 musl 处理。
 * 保守默认是有意为之——宁可拒绝可疑目标，也不跨 libc 切换。
 */
export function localRuntimeIsMusl(platform: string = process.platform): boolean {
	if (platform !== "linux") return false;
	try {
		const report = process.report?.getReport?.() as
			| { header?: { glibcVersionRuntime?: unknown } }
			| undefined;
		return typeof report?.header?.glibcVersionRuntime !== "string";
	} catch {
		return true;
	}
}

function releaseTargetError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function fileSha256(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * 停旧进程前的目标复验（纯本地、无网络）：清单、构件入口、描述文件、签名与哈希。
 * musl Client 包必须带描述文件且签名可验；本机 musl 缺描述文件直接失败关闭。
 */
export function assertPreparedTarget(input: {
	versionDir: string;
	artifact: "server" | "client";
	localMusl?: boolean;
}): MuslReleaseTarget | null {
	const { versionDir, artifact } = input;
	const localMusl = input.localMusl ?? localRuntimeIsMusl();
	let manifestRaw: unknown = null;
	try {
		manifestRaw = JSON.parse(readFileSync(join(versionDir, "manifest.json"), "utf-8"));
	} catch {
		manifestRaw = null;
	}
	if (
		!manifestRaw ||
		typeof manifestRaw !== "object" ||
		Array.isArray(manifestRaw)
	) {
		throw releaseTargetError(
			ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
			"目标构件清单不完整",
		);
	}
	const manifest = manifestRaw as UpdateManifest;
	const artifacts = manifest.artifacts as unknown as
		| Record<string, { dir?: string; entry?: string } | undefined>
		| undefined;
	const target = artifacts?.[artifact];
	if (!target?.dir || !target.entry) {
		throw releaseTargetError(
			ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
			`目标缺少 artifacts.${artifact}`,
		);
	}
	if (!existsSync(join(versionDir, target.dir, target.entry))) {
		throw releaseTargetError(
			ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
			"目标入口缺失",
		);
	}
	if (artifact !== "client") return null;

	const descriptor = readClientReleaseTarget(versionDir);
	if (!descriptor) {
		if (localMusl) {
			throw releaseTargetError(
				ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
				"musl 客户端缺少 release-target.json",
			);
		}
		return null;
	}
	if (!localMusl) {
		throw releaseTargetError(
			ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
			"目标平台与本机运行时不一致",
		);
	}
	if (artifacts?.server) {
		throw releaseTargetError(
			ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
			"musl Client 包不得携带 Server 构件",
		);
	}
	const descriptorPath = join(versionDir, "client", "release-target.json");
	const files = Array.isArray(manifest.files) ? manifest.files : [];
	const entry = files.find(
		(file) =>
			file &&
			typeof file === "object" &&
			(file as { path?: string }).path === "client/release-target.json",
	) as { sha256?: string } | undefined;
	if (
		!entry ||
		typeof entry.sha256 !== "string" ||
		entry.sha256.toLowerCase() !== fileSha256(descriptorPath)
	) {
		throw releaseTargetError(
			ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
			"release-target.json 哈希不匹配",
		);
	}
	const signaturePath = join(versionDir, "manifest.json.sig");
	if (!existsSync(signaturePath)) {
		throw releaseTargetError(
			ReleaseArtifactErrorCode.MANIFEST_SIGNATURE_INVALID,
			"缺少发布清单签名",
		);
	}
	const signature = readFileSync(signaturePath, "utf-8").trim();
	if (
		!verifyManifestSignature(
			manifestRaw as Record<string, unknown>,
			signature,
			loadTrustedPublicKeyPem(),
		)
	) {
		throw releaseTargetError(
			ReleaseArtifactErrorCode.MANIFEST_SIGNATURE_INVALID,
			"发布清单签名无效",
		);
	}
	return descriptor;
}

function streamSha256(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(filePath)
			.on("error", reject)
			.on("data", (c: Buffer) => hash.update(c))
			.on("end", () => resolve(hash.digest("hex")));
	});
}

/**
 * 更新包下载 URL 校验：仅允许 http/https 且带主机名。
 * 信任边界：控制通道为 127.0.0.1 + token（服务端自更新）；
 * 客户端场景 URL 来自经 PSK 认证的 WS 连接（服务端下发）。
 */
function validateUpdateUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`更新包 URL 无效`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`更新包 URL 协议不允许: ${parsed.protocol}`);
	}
	if (!parsed.hostname) {
		throw new Error(`更新包 URL 缺少主机名`);
	}
	return parsed.toString();
}

/** 下载更新包，瞬时网络失败和 502/503/504 最多重试三次。 */
export async function downloadWithRetry(
	url: string,
	destPath: string,
	fetchImpl: typeof fetch = fetch,
	sleepImpl: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
	const fullUrl = validateUpdateUrl(url);
	let lastError: unknown;
	for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
		let res: Response;
		try {
			res = await fetchImpl(fullUrl, {
				signal: AbortSignal.timeout(900_000),
			});
		} catch (error) {
			lastError = error;
			if (attempt >= DOWNLOAD_ATTEMPTS - 1) {
				throw new Error("下载失败: 网络错误");
			}
			await sleepImpl(DOWNLOAD_RETRY_DELAYS_MS[attempt] ?? 1000);
			continue;
		}

		if (!res.ok) {
			const error = new Error(`下载失败: HTTP ${res.status}`);
			if (!isTransientDownloadStatus(res.status)) throw error;
			lastError = error;
			if (attempt >= DOWNLOAD_ATTEMPTS - 1) throw error;
			await sleepImpl(DOWNLOAD_RETRY_DELAYS_MS[attempt] ?? 1000);
			continue;
		}

		// 响应已成功后，写盘/流处理错误是本地或数据面错误，不重试。
		await pipeline(res.body as never, createWriteStream(destPath));
		return;
	}
	throw lastError instanceof Error ? lastError : new Error("下载失败: 网络错误");
}

export class Daemon {
	private readonly appDir: string;
	private readonly artifact: "server" | "client";
	private readonly probeUrl: string;
	private readonly log: (msg: string) => void;
	private readonly versions: VersionStore;
	private readonly retention: VersionRetentionLike;
	private retentionTimer: ReturnType<typeof setTimeout> | null = null;
	private child: ChildProcess | null = null;
	private childStartedAt = 0;
	private updating = false;
	private stopping = false;
	private crashCount = 0;
	private pendingVersion: string | null = null;
	/** 后台 prepare 任务（受理后下载/校验/组装）；apply 前必须等待完成 */
	private prepareTask: Promise<void> | null = null;
	/** 后台 prepare 状态快照；失败也要如实回报，不再静默吞掉 */
	private prepareStatusValue: LauncherPrepareStatus = {
		state: "idle",
		version: null,
	};
	private nodePath: string | null = null;
	private updater!: Updater;

	constructor(config: DaemonConfig) {
		this.appDir = config.appDir;
		this.artifact = config.artifact;
		this.probeUrl = config.probeUrl ?? "http://127.0.0.1:3001/api/status";
		this.log = config.log ?? ((msg) => console.log(`[launcher] ${msg}`));
		this.versions = new VersionStore({
			appsDir: join(this.appDir, "apps"),
		});
		this.retention =
			config.retention ??
			new VersionRetention({
				appsDir: join(this.appDir, "apps"),
				versions: this.versions,
			});
	}

	async start(): Promise<void> {
		await mkdir(this.appDir, { recursive: true });
		this.updater = this.buildUpdater();

		// 优雅停机：先停被守护进程再退出（Windows kill() 不触发 handler，Ctrl+C 有效）
		const shutdown = () => {
			void this.shutdown();
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);

		const control = await createControlServer({
			controlFile: join(this.appDir, "control.json"),
			handlers: this.buildControlHandlers(),
			log: this.log,
		});

		await this.startCurrent(control.port, control.token);
		await this.initializeRetention();
		this.scheduleRetentionStartupCleanup();
		this.log(`守护中: ${this.artifact} (control port ${control.port})`);
	}

	/** 控制通道处理器：prepare 后台执行，成功与失败都写入可查询状态。 */
	private buildControlHandlers(): ControlHandlers {
		return {
			prepare: (input) => {
				// 立即受理：下载/校验/组装可能耗时数分钟，先行返回 200，
				// 避免请求方 fetch 默认超时在下载完成前切断连接。
				// 从受理开始就保护目标，避免启动补扫删除正在解压的目录。
				this.pendingVersion = input.version;
				this.prepareStatusValue = {
					state: "preparing",
					version: input.version,
				};
				this.prepareTask = this.updater
					.prepare(input)
					.then(() => {
						this.prepareStatusValue = {
							state: "ready",
							version: input.version,
						};
					})
					.catch((error: unknown) => {
						if (this.pendingVersion === input.version) {
							this.pendingVersion = null;
						}
						const code = safePrepareErrorCode(error);
						this.prepareStatusValue = {
							state: "failed",
							version: input.version,
							errorCode: code,
						};
						this.log(`准备失败: ${code}`);
					});
				return Promise.resolve();
			},
			apply: async () => {
				if (this.prepareTask) await this.prepareTask;
				if (this.prepareStatusValue.state === "failed") {
					throw Object.assign(new Error("版本准备失败"), {
						code:
							this.prepareStatusValue.errorCode ??
							ReleaseArtifactErrorCode.ASSEMBLE_FAILED,
					});
				}
				const version = this.pendingVersion;
				if (!version) throw new Error("尚未 prepare");
				await this.applyUpdate(version);
			},
			prepareStatus: () => ({ ...this.prepareStatusValue }),
		};
	}

	/** 优雅停机：置停机标志并停掉被守护进程 */
	private async shutdown(): Promise<void> {
		this.stopping = true;
		this.cancelRetentionStartupCleanup();
		this.log("收到停机信号，停止被守护进程");
		await this.stopChild();
		process.exit(0);
	}

	/** 更新流程：preStart 钩子 → stop/switch/start/probe/回退 */
	private async applyUpdate(version: string): Promise<void> {
		// apply 全程保留 pendingVersion，避免启动补扫删除正在切换的目标。
		const versionDir = join(this.appDir, "apps", version);
		const manifest = readManifest(versionDir);
		const artifact = manifest?.artifacts[this.artifact];
		try {
			// preStart 仅 server 构件支持（如 prisma db push）
			const preStart =
				this.artifact === "server"
					? manifest?.artifacts.server?.preStart
					: undefined;
			if (artifact && preStart) {
				await runPreStart(preStart, join(versionDir, artifact.dir));
			}
			await this.updater.apply(version);
		} finally {
			if (this.pendingVersion === version) this.pendingVersion = null;
		}
	}

	/** 启动 current 版本进程（含 ensure-node） */
	private async startCurrent(port?: number, token?: string): Promise<void> {
		const version = await this.versions.currentVersion();
		if (!version) {
			throw new Error(
				"尚未部署任何版本（apps/current 不存在）；请先手动安装初始版本",
			);
		}
		const versionDir = join(this.appDir, "apps", version);
		const manifest = readManifest(versionDir);
		const artifact = manifest?.artifacts[this.artifact];
		if (!artifact) {
			throw new Error(`manifest 缺少 artifacts.${this.artifact}: ${version}`);
		}

		// 先准备新运行时，再回收旧 Client：运行时解析失败时旧进程仍在服务，不会两头落空。
		this.nodePath = await this.resolveClientRuntime(versionDir, manifest);
		this.reclaimStaleOwnedProcess();

		const child = spawn(this.nodePath, [artifact.entry], {
			cwd: join(versionDir, artifact.dir),
			stdio: "inherit",
			// Windows 下必须隐藏子进程控制台，否则 client 会弹可见黑窗
			windowsHide: true,
			env: {
				...process.env,
				VCPDECK_LAUNCHER_PORT: port ? String(port) : undefined,
				VCPDECK_LAUNCHER_TOKEN: token,
			} as NodeJS.ProcessEnv,
		});
		this.child = child;
		this.childStartedAt = Date.now();
		this.recordOwnedProcess(child.pid);
		child.on("exit", (code) => {
			if (this.child !== child) return;
			this.child = null;
			if (this.updating || this.stopping) return; // 更新/停机期间的退出是预期的
			this.scheduleRestart(code);
		});
		this.log(`已启动 ${this.artifact} ${version}`);
	}

	/** musl Client 必须用包内锁定的私有 Node；glibc 包保持原 ensure-node 路径。 */
	private async resolveClientRuntime(
		versionDir: string,
		manifest: UpdateManifest | null,
	): Promise<string> {
		const target =
			this.artifact === "client" ? readClientReleaseTarget(versionDir) : null;
		if (target) {
			return ensureMuslRuntime(
				target,
				join(this.appDir, "runtime"),
				manifest?.nodeVersion ?? ">=24",
			);
		}
		return ensureNodeRuntime({
			constraint: manifest?.nodeVersion ?? ">=24",
			cacheDir: join(this.appDir, "node"),
		});
	}

	/**
	 * 停旧进程前的目标复验：清单、构件入口、描述文件、签名与 musl 运行时都必须仍然成立。
	 * 任何一项不成立都直接抛错，调用方因此不会先停服务再发现新版本起不来。
	 */
	private async validatePreparedTarget(version: string): Promise<void> {
		const versionDir = join(this.appDir, "apps", version);
		const target = assertPreparedTarget({
			versionDir,
			artifact: this.artifact,
		});
		if (!target) return;
		await ensureMuslRuntime(
			target,
			join(this.appDir, "runtime"),
			readManifest(versionDir)?.nodeVersion ?? ">=24",
		);
	}

	/** Linux Client 启动后写入 PID 所有权账本，供 procd 停服 / 卸载确认不遗留进程。 */
	private recordOwnedProcess(pid: number | undefined): void {
		if (!pid || process.platform !== "linux" || this.artifact !== "client") return;
		const stateDir = process.env.VCPDECK_CLIENT_DATA_DIR ?? this.appDir;
		try {
			// 必须记录 Client 子进程的四元组；默认参数记的是 Launcher 自己。
			writeOwnedLedger(stateDir, readOwnedProcessFacts(pid));
		} catch (error) {
			this.log(`所有权账本写入跳过: ${(error as Error).message}`);
		}
	}

	/**
	 * 启动前回收遗留的受管 Client：账本里若仍有一个活着的 Client（bootId+startTime+uid 一致），
	 * 说明上一实例没有被 procd 停掉。按四元组复证后强杀它，再拉起新实例；
	 * 复证不成立（PID 复用/重启）时不碰该进程，直接视为无有效记录。
	 */
	private reclaimStaleOwnedProcess(): void {
		if (process.platform !== "linux" || this.artifact !== "client") return;
		const stateDir = process.env.VCPDECK_CLIENT_DATA_DIR ?? this.appDir;
		// 账本损坏时 fail-closed：不能把“读不出证据”当成“没有遗留进程”。
		reclaimOwnedProcess(stateDir, { log: (message) => this.log(message) });
	}

	/** 崩溃退避拉起（运行满 30s 视为稳定，计数清零；超上限放弃） */
	private scheduleRestart(code: number | null): void {
		if (Date.now() - this.stableSinceMs() > STABLE_WINDOW_MS) {
			this.crashCount = 0;
		}
		this.crashCount++;
		this.log(`进程退出（code=${code}），第 ${this.crashCount} 次崩溃`);
		if (this.crashCount > MAX_CRASH_RETRIES) {
			this.log("连续崩溃超过上限，放弃拉起（等待手动处理或新版本）");
			return;
		}
		const delay = Math.min(1000 * 2 ** (this.crashCount - 1), 30_000);
		setTimeout(() => {
			if (!this.updating && !this.stopping && !this.child) {
				void this.startCurrent().catch((e: Error) =>
					this.log(`拉起失败: ${e.message}`),
				);
			}
		}, delay);
	}

	private stableSinceMs(): number {
		// 进程启动时间近似：崩溃退避以最近一次 startCurrent 为基准
		return this.lastStartAt;
	}

	private lastStartAt = 0;

	private async stopChild(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = null;
		child.kill("SIGTERM");
		// 停机阶梯：Client 资源释放 8s < 这里的强杀 10s < procd term_timeout 15s。
		// 改这一处必须同步 packages/client/src/shutdown.ts 与 scripts/vcpdeck-client.procd。
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// 进程可能已退出
				}
				resolve();
			}, 10_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/** 健康探活：server 走 HTTP + 版本匹配；client 需存活超过稳定窗口（秒退进程判失败） */
	private async probe(version: string): Promise<boolean> {
		if (this.artifact === "server") {
			try {
				const res = await fetch(this.probeUrl, {
					signal: AbortSignal.timeout(5000),
				});
				if (!res.ok) return false;
				const body = (await res.json()) as { serverVersion?: string };
				return body.serverVersion === version;
			} catch {
				return false;
			}
		}
		return (
			this.child !== null &&
			this.child.exitCode === null &&
			Date.now() - this.childStartedAt > CLIENT_PROBE_STABLE_MS
		);
	}

	private async initializeRetention(): Promise<void> {
		try {
			await this.retention.initialize();
		} catch {
			this.log("版本保留状态初始化失败，已跳过自动清理");
		}
	}

	private scheduleRetentionStartupCleanup(): void {
		this.cancelRetentionStartupCleanup();
		this.retentionTimer = setTimeout(() => {
			this.retentionTimer = null;
			if (this.stopping) return;
			const protectedVersions = this.pendingVersion
				? new Set([this.pendingVersion])
				: undefined;
			void this.runRetentionCleanup(protectedVersions);
		}, RETENTION_STARTUP_DELAY_MS);
	}

	private cancelRetentionStartupCleanup(): void {
		if (this.retentionTimer === null) return;
		clearTimeout(this.retentionTimer);
		this.retentionTimer = null;
	}

	private async runRetentionCleanup(
		protectedVersions?: ReadonlySet<string>,
	): Promise<void> {
		try {
			const result = await this.retention.cleanup(protectedVersions);
			this.log(
				`版本清理完成: 删除 ${result.removed.length} 项，失败 ${result.failed.length} 项`,
			);
		} catch {
			this.log("版本清理失败，保留本地版本目录供人工处理");
		}
	}

	private async onSuccessfulApply(
		version: string,
		previous: string | null,
	): Promise<void> {
		const recorded = await this.retention.recordSuccessful(version);
		if (!recorded) return;
		const protectedVersions = new Set<string>([version]);
		if (previous) protectedVersions.add(previous);
		await this.runRetentionCleanup(protectedVersions);
	}

	private buildUpdater(): Updater {
		return new Updater({
			versions: this.versions,
			artifact: this.artifact,
			downloadZip: async (url, destPath) => {
				// 相对路径（服务端自更新）拼本机服务地址
				const fullUrl = url.startsWith("http")
					? url
					: new URL(url, this.probeUrl).toString();
				this.log("下载更新包");
				await downloadWithRetry(fullUrl, destPath, fetch, async (ms) => {
					this.log(`下载更新包重试等待: ${ms}ms`);
					await new Promise((resolve) => setTimeout(resolve, ms));
				});
			},
			verifySha256: async (filePath, expected) =>
				(await streamSha256(filePath)) === expected,
			extractZip: (zipPath, destDir) => extractArchive(zipPath, destDir),
			stopProcess: async () => {
				this.updating = true;
				await this.stopChild();
			},
			startProcess: async () => {
				this.lastStartAt = Date.now();
				await this.startCurrent();
				this.updating = false;
			},
			probe: (version) => this.probe(version),
			// musl 私有运行时缓存已存在说明本机是 musl 安装：跨 libc 不接受 delta。
			acceptsDelta: () => !existsSync(join(this.appDir, "runtime")),
			validatePreparedTarget: (version) => this.validatePreparedTarget(version),
			onSuccessfulApply: (version, previous) =>
				this.onSuccessfulApply(version, previous),
		});
	}
}

/**
 * ADR-0027：Windows SYSTEM 开机任务不注入环境变量，改为读取安装根下的 launcher.env。
 * 已存在的同名环境变量优先（PM2 与手动启动路径不受影响）；值不做引号剥离外的解析。
 */
export function loadLauncherEnvFile(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): void {
	const appDir = env.VCPDECK_APP_DIR ?? cwd;
	let text: string;
	try {
		text = readFileSync(join(appDir, "launcher.env"), "utf8");
	} catch {
		return;
	}
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const index = trimmed.indexOf("=");
		if (index <= 0) continue;
		const key = trimmed.slice(0, index).trim();
		if (!key || env[key] !== undefined) continue;
		env[key] = trimmed.slice(index + 1).trim();
	}
}

/** 从环境变量加载配置 */
export function loadConfigFromEnv(): DaemonConfig {
	loadLauncherEnvFile();
	const appDir =
		process.env.VCPDECK_APP_DIR ?? join(homedir(), ".vcpdeck", "launcher");
	const artifact = process.env.VCPDECK_ARTIFACT;
	if (artifact !== "server" && artifact !== "client") {
		throw new Error("VCPDECK_ARTIFACT 必须为 server 或 client");
	}
	return {
		appDir,
		artifact,
		probeUrl: process.env.VCPDECK_PROBE_URL,
	};
}
