import { constants } from "node:fs";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

const CLI_CONFIG_VERSION = 1;
const PROJECT_CONFIG_FILE = ".vcpdeck.json";
const ENVIRONMENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENVIRONMENT_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 密码登录环境；密码只通过环境变量引用。 */
export interface PasswordEnvironmentConfig {
	server: string;
	auth: {
		type: "password";
		username: string;
		passwordEnv: string;
	};
}

/** Bearer 登录环境；Token 只通过环境变量引用。 */
export interface BearerEnvironmentConfig {
	server: string;
	auth: {
		type: "bearer";
		tokenEnv: string;
	};
}

/** 用户级环境定义。 */
export type EnvironmentConfig =
	| PasswordEnvironmentConfig
	| BearerEnvironmentConfig;

/** 用户级 CLI 配置。 */
export interface CliConfig {
	version: 1;
	defaultEnvironment?: string;
	environments: Record<string, EnvironmentConfig>;
}

/** 项目级配置只能选择用户级环境，不能定义 Server 或凭据。 */
export interface ProjectConfig {
	version: 1;
	environment: string;
}

/** 配置文件与查找路径注入，供 CLI 与测试复用。 */
export interface ConfigPaths {
	globalConfigPath: string;
	cwd: string;
}

export function defaultConfigPaths(cwd = process.cwd()): ConfigPaths {
	return {
		globalConfigPath: join(homedir(), ".vcpdeck", "cli", "config.json"),
		cwd: resolve(cwd),
	};
}

/** 规范化并校验 Server URL。 */
export function normalizeServerUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Server URL 无效: ${value}`);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
		throw new Error("Server URL 必须是带主机名的 http/https 地址");
	}
	if (url.username || url.password) {
		throw new Error("Server URL 不得内嵌用户名或密码");
	}
	if (url.search || url.hash) {
		throw new Error("Server URL 不得包含 query 或 fragment");
	}
	if (url.pathname !== "/" && url.pathname !== "") {
		throw new Error("Server URL 必须是 origin，不得包含业务路径");
	}
	return url.origin;
}

export function assertEnvironmentName(name: string): void {
	if (
		!ENVIRONMENT_NAME_RE.test(name) ||
		name === "__proto__" ||
		name === "constructor" ||
		name === "prototype"
	) {
		throw new Error(
			"环境名必须以字母或数字开头，只含字母、数字、点、下划线、连字符（最长 64），且不能使用保留名称",
		);
	}
}

export function assertEnvironmentVariableName(name: string): void {
	if (!ENVIRONMENT_VARIABLE_RE.test(name)) {
		throw new Error(`环境变量名无效: ${name}`);
	}
}

/** 严格解析用户级配置，拒绝未知字段和明文秘密。 */
export function parseCliConfig(value: unknown): CliConfig {
	const root = requireRecord(value, "CLI 配置");
	assertOnlyKeys(
		root,
		["version", "defaultEnvironment", "environments"],
		"CLI 配置",
	);
	if (root.version !== CLI_CONFIG_VERSION) {
		throw new Error(`CLI 配置 version 必须为 ${CLI_CONFIG_VERSION}`);
	}
	if (root.defaultEnvironment !== undefined) {
		if (typeof root.defaultEnvironment !== "string") {
			throw new Error("defaultEnvironment 必须是字符串");
		}
		assertEnvironmentName(root.defaultEnvironment);
	}

	const environmentsValue = requireRecord(root.environments, "environments");
	const environments: Record<string, EnvironmentConfig> = {};
	for (const [name, rawEnvironment] of Object.entries(environmentsValue)) {
		assertEnvironmentName(name);
		environments[name] = parseEnvironment(rawEnvironment, name);
	}
	if (
		root.defaultEnvironment !== undefined &&
		!Object.hasOwn(environments, root.defaultEnvironment)
	) {
		throw new Error(`默认环境不存在: ${root.defaultEnvironment}`);
	}
	const config: CliConfig = { version: 1, environments };
	if (root.defaultEnvironment) {
		config.defaultEnvironment = root.defaultEnvironment;
	}
	return config;
}

/** 严格解析项目选择器。 */
export function parseProjectConfig(value: unknown): ProjectConfig {
	const root = requireRecord(value, "项目配置");
	assertOnlyKeys(root, ["version", "environment"], "项目配置");
	if (root.version !== CLI_CONFIG_VERSION) {
		throw new Error(`项目配置 version 必须为 ${CLI_CONFIG_VERSION}`);
	}
	if (typeof root.environment !== "string") {
		throw new Error("项目配置 environment 必须是字符串");
	}
	assertEnvironmentName(root.environment);
	return { version: 1, environment: root.environment };
}

export async function loadCliConfig(
	path: string,
	options: { required?: boolean } = {},
): Promise<CliConfig> {
	const value = await readJson(path, options.required ?? false);
	return value === undefined
		? { version: CLI_CONFIG_VERSION, environments: {} }
		: parseCliConfig(value);
}

export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
	const value = await readJson(path, true);
	return parseProjectConfig(value);
}

/** 本地选择器写入目标：优先已有最近配置，其次 Git 根，最后当前目录。 */
export async function localProjectConfigTarget(cwd: string): Promise<string> {
	const normalizedCwd = resolve(cwd);
	const existing = await findProjectConfig(normalizedCwd);
	if (existing) return existing;

	let directory = normalizedCwd;
	for (;;) {
		if (await exists(join(directory, ".git"))) {
			return join(directory, PROJECT_CONFIG_FILE);
		}
		const parent = dirname(directory);
		if (parent === directory) return join(normalizedCwd, PROJECT_CONFIG_FILE);
		directory = parent;
	}
}

/** 原子写入用户级配置；POSIX 下目录与文件分别限制为 0700/0600。 */
export async function saveCliConfig(
	path: string,
	config: CliConfig,
): Promise<void> {
	const validated = parseCliConfig(config);
	await writeJsonAtomic(path, validated, true);
}

/** 原子写入项目级环境选择器。 */
export async function saveProjectConfig(
	path: string,
	config: ProjectConfig,
): Promise<void> {
	const validated = parseProjectConfig(config);
	await writeJsonAtomic(path, validated, false);
}

/** 从 cwd 向上查找最近项目配置；Git 仓库内最多查到仓库根。 */
export async function findProjectConfig(
	cwd: string,
): Promise<string | undefined> {
	let directory = resolve(cwd);
	for (;;) {
		const candidate = join(directory, PROJECT_CONFIG_FILE);
		if (await exists(candidate)) return candidate;
		if (await exists(join(directory, ".git"))) return undefined;
		const parent = dirname(directory);
		if (parent === directory || directory === parse(directory).root)
			return undefined;
		directory = parent;
	}
}

function parseEnvironment(value: unknown, name: string): EnvironmentConfig {
	const root = requireRecord(value, `环境 ${name}`);
	assertOnlyKeys(root, ["server", "auth"], `环境 ${name}`);
	if (typeof root.server !== "string") {
		throw new Error(`环境 ${name}.server 必须是字符串`);
	}
	const server = normalizeServerUrl(root.server);
	const auth = requireRecord(root.auth, `环境 ${name}.auth`);
	if (auth.type === "password") {
		assertOnlyKeys(
			auth,
			["type", "username", "passwordEnv"],
			`环境 ${name}.auth`,
		);
		if (typeof auth.username !== "string" || !auth.username.trim()) {
			throw new Error(`环境 ${name}.auth.username 不能为空`);
		}
		if (typeof auth.passwordEnv !== "string") {
			throw new Error(`环境 ${name}.auth.passwordEnv 必须是字符串`);
		}
		assertEnvironmentVariableName(auth.passwordEnv);
		return {
			server,
			auth: {
				type: "password",
				username: auth.username,
				passwordEnv: auth.passwordEnv,
			},
		};
	}
	if (auth.type === "bearer") {
		assertOnlyKeys(auth, ["type", "tokenEnv"], `环境 ${name}.auth`);
		if (typeof auth.tokenEnv !== "string") {
			throw new Error(`环境 ${name}.auth.tokenEnv 必须是字符串`);
		}
		assertEnvironmentVariableName(auth.tokenEnv);
		return { server, auth: { type: "bearer", tokenEnv: auth.tokenEnv } };
	}
	throw new Error(`环境 ${name}.auth.type 必须为 password 或 bearer`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} 必须是对象`);
	}
	return value as Record<string, unknown>;
}

function assertOnlyKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unknown.length)
		throw new Error(`${label} 含未知字段: ${unknown.join(", ")}`);
}

async function readJson(
	path: string,
	required: boolean,
): Promise<unknown | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT") && !required) return undefined;
		if (isErrno(error, "ENOENT")) throw new Error(`配置文件不存在: ${path}`);
		throw error;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`配置文件不是有效 JSON: ${path}`);
	}
}

async function writeJsonAtomic(
	path: string,
	value: unknown,
	privateFile: boolean,
): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: privateFile ? 0o700 : 0o755 });
	if (privateFile && process.platform !== "win32") await chmod(directory, 0o700);
	const tempPath = join(directory, `.${Date.now()}-${process.pid}.tmp`);
	try {
		await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: privateFile ? 0o600 : 0o644,
		});
		if (privateFile && process.platform !== "win32") await chmod(tempPath, 0o600);
		await rename(tempPath, path);
		if (privateFile && process.platform !== "win32") await chmod(path, 0o600);
	} finally {
		try {
			await rm(tempPath, { force: true });
		} catch {
			// 主写入结果优先；临时文件清理失败不覆盖原始错误。
		}
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}
