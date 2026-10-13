import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { VcpDeckApiError, type VcpDeckClient } from "@vcpdeck/sdk";
import {
	ReleaseClientState,
	ReleaseStatus,
	selectLatestCatchUpTarget,
	type ReleaseInfo,
	type ReleasePlatform,
} from "@vcpdeck/shared";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { resolveClientId } from "./client-resolver.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import type { ConfigPaths } from "./config.js";
import {
	formatEnvironmentSummary,
	resolveEnvironment,
	type ResolvedEnvironment,
} from "./environment.js";

const VERSION_RE = /^vcpdeck-(\d+\.\d+\.\d+)-(win-x64|linux-x64)\.zip$/;
const VERSION_INPUT_RE = /^\d+\.\d+\.\d+$/;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 1_800;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface ReleaseCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	pollIntervalMs?: number;
	requestTimeoutMs?: number;
	/** Release 直传 Provider 时使用；测试可注入。 */
	directFetch?: typeof globalThis.fetch;
	/** 分片重试退避；测试可缩短。 */
	directRetryDelayMs?: number;
}

interface ReleaseClientCounts {
	done: number;
	failed: number;
	updating: number;
	pending: number;
}

/** 执行 Release 命令组。 */
export async function runReleaseCommand(
	subcommand: string | undefined,
	argv: string[],
	context: ReleaseCommandContext = {},
): Promise<void> {
	if (subcommand === "upload") {
		await runUploadCommand(argv, context);
		return;
	}
	if (subcommand === "status" || subcommand === "wait") {
		await runInspectCommand(subcommand, argv, context);
		return;
	}
	if (subcommand === "retry") {
		await runRetryCommand(argv, context);
		return;
	}
	throw new Error(releaseUsage());
}

function releaseUsage(): string {
	return [
		"Release 命令:",
		"  vcpdeck release status <version> [--env=<name>]",
		"  vcpdeck release wait <version> [--env=<name>] [--timeout=<seconds>]",
		"  vcpdeck release retry <client> [--version=<version>] [--env=<name>] [--json]",
		"  vcpdeck release upload <win-x64.zip> <linux-x64.zip> [--env=<name>] [--wait] [--timeout=<seconds>]",
		"  兼容直连: 添加 --server=<url> [--username=<name> --password=<value>]",
	].join("\n");
}

/**
 * 人工强制重试某个客户端的补更。
 * 省略 `--version` 时使用当前补更目标（双平台构件齐备且已进入客户端更新阶段或已完成）。
 */
async function runRetryCommand(
	argv: string[],
	context: ReleaseCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: [
			"env",
			"environment",
			"server",
			"username",
			"password",
			"version",
		],
		boolean: ["json"],
	});
	if (positionals.length !== 1) throw new Error(releaseUsage());
	const version = stringOption(options, "version");
	if (version !== undefined && !VERSION_INPUT_RE.test(version)) {
		throw new Error(`版本号格式非法: ${version}`);
	}
	const environment = await resolveCommandEnvironment(options, context);
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	const client = await createAuthenticatedClient(environment);
	const clientId = await resolveClientId(
		positionals[0],
		context.paths,
		context.processEnv,
		client,
	);
	const targetVersion = version ?? (await resolveCatchUpTargetVersion(client));
	const result = await client.releases.retryClient(targetVersion, clientId);
	if (options.json) {
		log(JSON.stringify(result, null, 2));
		return;
	}
	log(
		[
			`环境: ${environment.name}`,
			`机器: ${positionals[0]}`,
			`目标版本: ${result.version}`,
			"已触发补更；终态以该机器重新注册的版本为准，可用 release status 核对。",
		].join("\n"),
	);
}

/** 读取当前补更目标版本；没有可用目标时明确失败。 */
async function resolveCatchUpTargetVersion(
	client: VcpDeckClient,
): Promise<string> {
	const result = await client.releases.list({ page: 1, pageSize: 100 });
	const target = selectLatestCatchUpTarget(result.data);
	if (!target) {
		throw new Error(
			"当前没有可用的补更目标；请用 --version=<version> 显式指定版本",
		);
	}
	return target.version;
}

async function runUploadCommand(
	argv: string[],
	context: ReleaseCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "server", "username", "password", "timeout"],
		boolean: ["wait"],
	});
	if (positionals.length !== 2) throw new Error(releaseUsage());
	validateArchives(positionals);
	if (!options.wait && options.timeout !== undefined) {
		throw new Error("--timeout 仅与 --wait 一起使用");
	}
	const environment = await resolveCommandEnvironment(options, context);
	const log = context.log ?? console.log;
	const client = await uploadRelease(positionals, environment, log, context);
	if (options.wait) {
		await waitForRelease(
			client,
			platformOfFile(positionals[0]).version,
			parseTimeoutSeconds(options),
			log,
			context,
		);
	} else {
		log(
			"[vcpdeck] 上传成功不代表更新完成；使用 release wait <version> 或上传时添加 --wait 验收终态",
		);
	}
}

async function runInspectCommand(
	subcommand: "status" | "wait",
	argv: string[],
	context: ReleaseCommandContext,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: [
			"env",
			"environment",
			"server",
			"username",
			"password",
			...(subcommand === "wait" ? ["timeout"] : []),
		],
	});
	if (positionals.length !== 1 || !VERSION_INPUT_RE.test(positionals[0])) {
		throw new Error(releaseUsage());
	}
	const environment = await resolveCommandEnvironment(options, context);
	const log = context.log ?? console.log;
	log(formatEnvironmentSummary(environment));
	const client = await createAuthenticatedClient(environment);
	if (subcommand === "wait") {
		await waitForRelease(
			client,
			positionals[0],
			parseTimeoutSeconds(options),
			log,
			context,
		);
		return;
	}
	const snapshot = await readReleaseSnapshot(
		client,
		positionals[0],
		context.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
	);
	if (!snapshot.release) throw new Error(`Release 不存在: ${positionals[0]}`);
	log(
		formatReleaseSummary(
			snapshot.release,
			snapshot.serverVersion,
			await readClientNames(client),
		),
	);
}

async function resolveCommandEnvironment(
	options: Record<string, string | true>,
	context: ReleaseCommandContext,
): Promise<ResolvedEnvironment> {
	const environment = exclusiveAlias(options, "env", "environment");
	const server = stringOption(options, "server");
	const username = stringOption(options, "username");
	const password = stringOption(options, "password");
	if (!server && (username || password)) {
		throw new Error("--username/--password 只用于 --server 直连模式");
	}
	return resolveEnvironment({
		environment,
		server,
		username,
		password,
		paths: context.paths,
		processEnv: context.processEnv,
	});
}

async function uploadRelease(
	zipPaths: string[],
	environment: ResolvedEnvironment,
	log: (message: string) => void,
	context: ReleaseCommandContext,
): Promise<VcpDeckClient> {
	log(formatEnvironmentSummary(environment));
	const client = await createAuthenticatedClient(environment);
	for (const zipPath of zipPaths) {
		await uploadOne(client, zipPath, log, context);
	}
	log("[vcpdeck] 上传完成（两个平台构件齐备后服务端自动开始更新）");
	return client;
}

async function waitForRelease(
	client: VcpDeckClient,
	version: string,
	timeoutSeconds: number,
	log: (message: string) => void,
	context: ReleaseCommandContext,
): Promise<void> {
	const deadline = Date.now() + timeoutSeconds * 1_000;
	const pollInterval = context.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const requestTimeout = context.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	let lastSummary: string | undefined;
	let waitingForServer = false;
	while (Date.now() < deadline) {
		try {
			const snapshot = await readReleaseSnapshot(client, version, requestTimeout);
			waitingForServer = false;
			if (!snapshot.release) throw new Error(`Release 不存在: ${version}`);
			const summary = formatReleaseSummary(
				snapshot.release,
				snapshot.serverVersion,
			);
			if (summary !== lastSummary) {
				log(summary);
				lastSummary = summary;
			}
			assertReleaseNotFailed(snapshot.release);
			if (snapshot.release.status === ReleaseStatus.DONE) {
				assertReleaseCompleted(snapshot.release, snapshot.serverVersion);
				log(`[vcpdeck] 发版 ${version} 验收完成`);
				return;
			}
		} catch (error) {
			if (!isTransientReadError(error)) throw error;
			if (!waitingForServer) {
				log("[vcpdeck] Server 暂时不可达，等待重启完成…");
				waitingForServer = true;
			}
		}
		await sleep(Math.min(pollInterval, Math.max(0, deadline - Date.now())));
	}
	throw new Error(`等待发版 ${version} 超时（${timeoutSeconds} 秒）`);
}

async function readReleaseSnapshot(
	client: VcpDeckClient,
	version: string,
	requestTimeoutMs: number,
): Promise<{ release: ReleaseInfo | undefined; serverVersion: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
	try {
		const [release, status] = await Promise.all([
			findRelease(client, version, controller.signal),
			client.releases.status(controller.signal),
		]);
		return { release, serverVersion: status.serverVersion };
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

async function findRelease(
	client: VcpDeckClient,
	version: string,
	signal?: AbortSignal,
): Promise<ReleaseInfo | undefined> {
	for (let page = 1; ; page++) {
		const result = await client.releases.list({ page, pageSize: 100 }, signal);
		const found = result.data.find((release) => release.version === version);
		if (found) return found;
		if (page >= result.totalPages) return undefined;
	}
}

function formatReleaseSummary(
	release: ReleaseInfo,
	serverVersion: string,
	clientNames: Map<string, string> = new Map(),
): string {
	const counts = countClientStates(release);
	const lines = [
		`版本: ${release.version}`,
		`Server: ${serverVersion}`,
		`Release: ${release.status}`,
		`客户端: 成功 ${counts.done} · 失败 ${counts.failed} · 进行中 ${counts.updating} · 待更新 ${counts.pending}`,
	];
	const entries = Object.entries(release.clientStates).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	if (entries.length > 0) {
		lines.push("逐台明细:");
		for (const [clientId, entry] of entries) {
			const name = clientNames.get(clientId) ?? clientId;
			const parts = [`  ${name}`, entry.state];
			if (entry.kind) parts.push(entry.kind === "permanent" ? "永久失败" : "可重试");
			if (entry.attempts !== undefined) parts.push(`已试 ${entry.attempts} 次`);
			if (entry.reason) parts.push(`原因: ${entry.reason}`);
			lines.push(parts.join(" · "));
		}
	}
	return lines.join("\n");
}

/** 读取机器名称映射；失败时回退为 clientId，不影响明细展示。 */
async function readClientNames(
	client: VcpDeckClient,
): Promise<Map<string, string>> {
	try {
		const clients = await client.clients.list();
		return new Map(clients.map((entry) => [entry.clientId, entry.name]));
	} catch {
		return new Map();
	}
}

function countClientStates(release: ReleaseInfo): ReleaseClientCounts {
	const counts: ReleaseClientCounts = {
		done: 0,
		failed: 0,
		updating: 0,
		pending: 0,
	};
	for (const entry of Object.values(release.clientStates)) {
		if (entry.state === ReleaseClientState.DONE) counts.done++;
		else if (entry.state === ReleaseClientState.FAILED) counts.failed++;
		else if (entry.state === ReleaseClientState.UPDATING) counts.updating++;
		else counts.pending++;
	}
	return counts;
}

function assertReleaseNotFailed(release: ReleaseInfo): void {
	if (release.status === ReleaseStatus.FAILED) {
		throw new Error(
			`发版 ${release.version} 失败${release.errorMessage ? `: ${release.errorMessage}` : ""}`,
		);
	}
}

function assertReleaseCompleted(
	release: ReleaseInfo,
	serverVersion: string,
): void {
	const counts = countClientStates(release);
	if (serverVersion !== release.version) {
		throw new Error(
			`发版 ${release.version} 已结束，但 Server 版本为 ${serverVersion}`,
		);
	}
	if (counts.failed > 0) {
		throw new Error(
			`发版 ${release.version} 已结束，但有 ${counts.failed} 个 Client 更新失败`,
		);
	}
	if (counts.updating > 0 || counts.pending > 0) {
		throw new Error(`发版 ${release.version} 已结束，但仍有未完成的 Client`);
	}
}

function isTransientReadError(error: unknown): boolean {
	if (error instanceof VcpDeckApiError) {
		return error.status === 0 || [502, 503, 504].includes(error.status);
	}
	return error instanceof Error && error.name === "AbortError";
}

function parseTimeoutSeconds(options: Record<string, string | true>): number {
	const raw = stringOption(options, "timeout");
	if (!raw) return DEFAULT_WAIT_TIMEOUT_SECONDS;
	const seconds = Number(raw);
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
		throw new Error("--timeout 必须是 1–86400 秒的整数");
	}
	return seconds;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateArchives(zipPaths: string[]): void {
	const archives = zipPaths.map(platformOfFile);
	if (new Set(archives.map((archive) => archive.version)).size !== 1) {
		throw new Error("两个平台构件必须使用相同版本号");
	}
	if (new Set(archives.map((archive) => archive.platform)).size !== 2) {
		throw new Error("必须各提供一个 win-x64 与 linux-x64 构件");
	}
}

/** 从文件名解析平台（vcpdeck-<x.y.z>-<platform>.zip）。 */
function platformOfFile(path: string): {
	version: string;
	platform: ReleasePlatform;
} {
	const name = path.split(/[\\/]/).pop() ?? "";
	const match = VERSION_RE.exec(name);
	if (!match) {
		throw new Error(
			`文件名应形如 vcpdeck-<x.y.z>-win-x64.zip / vcpdeck-<x.y.z>-linux-x64.zip: ${name}`,
		);
	}
	return { version: match[1], platform: match[2] as ReleasePlatform };
}

function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("error", reject)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")));
	});
}

/** 上传单个平台包；Alibaba 直传 Provider，Local/旧 Server 使用 legacy raw。 */
async function uploadOne(
	client: VcpDeckClient,
	zipPath: string,
	log: (message: string) => void,
	context: ReleaseCommandContext,
): Promise<ReleaseInfo> {
	const { version, platform } = platformOfFile(zipPath);
	const sha256 = await sha256File(zipPath);
	const { size } = await stat(zipPath);
	log(
		`[vcpdeck] 上传 ${zipPath} (${(size / 1024 / 1024).toFixed(1)} MB, ${platform}, sha256=${sha256.slice(0, 12)}…)`,
	);

	let session;
	try {
		session = await client.releases.createUploadSession({
			version,
			platform,
			sha256,
			size,
		});
	} catch (error) {
		if (!(error instanceof VcpDeckApiError) || error.status !== 404) throw error;
		log("[vcpdeck] 旧 Server 不支持直传会话，使用 legacy 引导上传");
		return legacyUpload(client, zipPath, version, platform, sha256);
	}

	if (session.mode === "existing") {
		log(`[vcpdeck] ${platform} 相同构件已登记，跳过上传`);
		return session.release;
	}
	if (session.mode === "server") {
		return legacyUpload(client, zipPath, version, platform, sha256);
	}
	if (session.mode !== "direct") {
		throw new Error("Server 返回未知 Release 上传模式");
	}

	await uploadDirectArchive(
		client,
		zipPath,
		platform,
		size,
		sha256,
		session,
		log,
		context,
	);
	const { release } = await client.releases.completeUploadSession(
		session.sessionId,
		size,
	);
	return release;
}

async function legacyUpload(
	client: VcpDeckClient,
	zipPath: string,
	version: string,
	platform: ReleasePlatform,
	sha256: string,
): Promise<ReleaseInfo> {
	const { release } = await client.releases.upload({
		version,
		platform,
		sha256,
		archive: createReadStream(zipPath) as unknown as BodyInit,
		duplex: "half",
	});
	return release;
}

async function uploadDirectArchive(
	client: VcpDeckClient,
	zipPath: string,
	platform: ReleasePlatform,
	size: number,
	expectedSha256: string,
	session: {
		sessionId: string;
		partSize: number;
		parts: Array<{ partNumber: number; url: string }>;
	},
	log: (message: string) => void,
	context: ReleaseCommandContext,
): Promise<void> {
	const expectedParts = Math.ceil(size / session.partSize);
	const parts = [...session.parts].sort((a, b) => a.partNumber - b.partNumber);
	if (
		session.partSize < 1 ||
		parts.length !== expectedParts ||
		parts.some(
			(part, index) =>
				part.partNumber !== index + 1 || !isSafeDirectUploadUrl(part.url),
		)
	) {
		throw new Error("Server 返回的 Release 直传分片不完整或 URL 不安全");
	}
	const handle = await open(zipPath, "r");
	const uploadedHash = createHash("sha256");
	try {
		for (const part of parts) {
			const start = (part.partNumber - 1) * session.partSize;
			const length = Math.min(session.partSize, size - start);
			const bytes = Buffer.allocUnsafe(length);
			const { bytesRead } = await handle.read(bytes, 0, length, start);
			if (bytesRead !== length)
				throw new Error(`读取分片 ${part.partNumber} 不完整`);
			uploadedHash.update(bytes);
			await putDirectPart(
				client,
				session.sessionId,
				part.partNumber,
				part.url,
				bytes,
				context,
			);
			log(
				`[vcpdeck] ${platform} 直传进度 ${Math.min(100, ((start + length) / size) * 100).toFixed(1)}%`,
			);
		}
	} finally {
		await handle.close();
	}
	if (uploadedHash.digest("hex") !== expectedSha256) {
		throw new Error("构件在计算 SHA-256 后发生变化，拒绝完成上传");
	}
}

async function putDirectPart(
	client: VcpDeckClient,
	sessionId: string,
	partNumber: number,
	initialUrl: string,
	bytes: Buffer,
	context: ReleaseCommandContext,
): Promise<void> {
	const fetcher = context.directFetch ?? globalThis.fetch;
	const retryDelay = context.directRetryDelayMs ?? 500;
	let url = initialUrl;
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await fetcher(url, {
				method: "PUT",
				headers: {
					"Content-Type": "",
					"Content-Length": String(bytes.length),
				},
				body: bytes as unknown as BodyInit,
			});
			if (response.ok || response.status === 409) return;
			if (response.status === 403 && attempt < 2) {
				const refreshed = await client.releases.refreshUploadParts(sessionId, [
					partNumber,
				]);
				url =
					refreshed.parts.find((part) => part.partNumber === partNumber)?.url ?? "";
				if (!isSafeDirectUploadUrl(url)) {
					throw new Error(`分片 ${partNumber} URL 刷新失败或不安全`);
				}
				continue;
			}
			lastError = new Error(
				`分片 ${partNumber} 上传失败：HTTP ${response.status}`,
			);
			if (response.status < 500) break;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
		if (attempt < 2) await sleep(retryDelay * (attempt + 1));
	}
	throw lastError ?? new Error(`分片 ${partNumber} 上传失败`);
}

function isSafeDirectUploadUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch {
		return false;
	}
}

function exclusiveAlias(
	options: Record<string, string | true>,
	first: string,
	second: string,
): string | undefined {
	const firstValue = stringOption(options, first);
	const secondValue = stringOption(options, second);
	if (firstValue && secondValue) {
		throw new Error(`--${first} 与 --${second} 不能同时使用`);
	}
	return firstValue ?? secondValue;
}
