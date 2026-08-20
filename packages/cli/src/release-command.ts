import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { VcpDeckApiError, type VcpDeckClient } from "@vcpdeck/sdk";
import {
	ReleaseClientState,
	ReleaseStatus,
	type ReleaseInfo,
	type ReleasePlatform,
} from "@vcpdeck/shared";
import { createAuthenticatedClient } from "./authenticated-client.js";
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
	throw new Error(releaseUsage());
}

function releaseUsage(): string {
	return [
		"Release 命令:",
		"  vcpdeck release status <version> [--env=<name>]",
		"  vcpdeck release wait <version> [--env=<name>] [--timeout=<seconds>]",
		"  vcpdeck release upload <win-x64.zip> <linux-x64.zip> [--env=<name>] [--wait] [--timeout=<seconds>]",
		"  兼容直连: 添加 --server=<url> [--username=<name> --password=<value>]",
	].join("\n");
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
	const client = await uploadRelease(positionals, environment, log);
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
	log(formatReleaseSummary(snapshot.release, snapshot.serverVersion));
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
): Promise<VcpDeckClient> {
	log(formatEnvironmentSummary(environment));
	const client = await createAuthenticatedClient(environment);
	for (const zipPath of zipPaths) {
		await uploadOne(client, zipPath, log);
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
): string {
	const counts = countClientStates(release);
	return [
		`版本: ${release.version}`,
		`Server: ${serverVersion}`,
		`Release: ${release.status}`,
		`客户端: 成功 ${counts.done} · 失败 ${counts.failed} · 进行中 ${counts.updating} · 待更新 ${counts.pending}`,
	].join("\n");
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

/** 上传单个平台包；文件读取与摘要留在 Node CLI，REST 协议由 SDK 负责。 */
async function uploadOne(
	client: VcpDeckClient,
	zipPath: string,
	log: (message: string) => void,
): Promise<ReleaseInfo> {
	const { version, platform } = platformOfFile(zipPath);
	const sha256 = await sha256File(zipPath);
	const { size } = await stat(zipPath);
	log(
		`[vcpdeck] 上传 ${zipPath} (${(size / 1024 / 1024).toFixed(1)} MB, ${platform}, sha256=${sha256.slice(0, 12)}…)`,
	);
	const { release } = await client.releases.upload({
		version,
		platform,
		sha256,
		archive: createReadStream(zipPath) as unknown as BodyInit,
		duplex: "half",
	});
	return release;
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
