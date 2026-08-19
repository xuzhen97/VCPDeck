import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { VcpDeckClient } from "@vcpdeck/sdk";
import type { ReleaseInfo, ReleasePlatform } from "@vcpdeck/shared";
import type { ConfigPaths } from "./config.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import {
	formatEnvironmentSummary,
	resolveEnvironment,
	type ResolvedEnvironment,
} from "./environment.js";

const VERSION_RE = /^vcpdeck-(\d+\.\d+\.\d+)-(win-x64|linux-x64)\.zip$/;

export interface ReleaseCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
}

/** 执行 Release 命令组。 */
export async function runReleaseCommand(
	subcommand: string | undefined,
	argv: string[],
	context: ReleaseCommandContext = {},
): Promise<void> {
	if (subcommand !== "upload") throw new Error(releaseUsage());
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "server", "username", "password"],
	});
	if (positionals.length !== 2) throw new Error(releaseUsage());
	validateArchives(positionals);
	const environmentName = exclusiveAlias(options, "env", "environment");
	const server = stringOption(options, "server");
	const username = stringOption(options, "username");
	const password = stringOption(options, "password");
	if (!server && (username || password)) {
		throw new Error("--username/--password 只用于 --server 直连模式");
	}
	const environment = await resolveEnvironment({
		environment: environmentName,
		server,
		username,
		password,
		paths: context.paths,
		processEnv: context.processEnv,
	});
	await uploadRelease(positionals, environment, context.log ?? console.log);
}

function releaseUsage(): string {
	return [
		"用法: vcpdeck release upload <win-x64.zip> <linux-x64.zip> [--env=<name>]",
		"兼容直连: ... --server=<url> [--username=<name> --password=<value>]",
	].join("\n");
}

async function uploadRelease(
	zipPaths: string[],
	environment: ResolvedEnvironment,
	log: (message: string) => void,
): Promise<void> {
	log(formatEnvironmentSummary(environment));
	const client = await createAuthenticatedClient(environment);
	for (const zipPath of zipPaths) {
		await uploadOne(client, zipPath, log);
	}
	log("[vcpdeck] 上传完成（两个平台构件齐备后服务端自动开始更新）");
	log(
		"[vcpdeck] 上传成功不代表更新完成，请在发版页面核对最终状态与 Client 明细",
	);
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

/** 根据环境认证方式创建 SDK 客户端。 */
async function createAuthenticatedClient(
	environment: ResolvedEnvironment,
): Promise<VcpDeckClient> {
	if (!environment.credentials) throw new Error("环境凭据未解析");
	if (environment.credentials.type === "bearer") {
		return new VcpDeckClient({
			baseUrl: environment.server,
			auth: { type: "bearer", token: environment.credentials.token },
		});
	}
	const loginClient = new VcpDeckClient({
		baseUrl: environment.server,
		auth: { type: "cookie" },
	});
	const { cookie } = await loginClient.auth.loginSession({
		username: environment.credentials.username,
		password: environment.credentials.password,
	});
	return new VcpDeckClient({
		baseUrl: environment.server,
		auth: { type: "cookie", cookie },
	});
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
