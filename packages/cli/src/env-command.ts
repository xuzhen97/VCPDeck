import {
	assertEnvironmentName,
	assertEnvironmentVariableName,
	defaultConfigPaths,
	loadCliConfig,
	localProjectConfigTarget,
	normalizeServerUrl,
	saveCliConfig,
	saveProjectConfig,
	type BearerEnvironmentConfig,
	type ConfigPaths,
	type EnvironmentConfig,
	type PasswordEnvironmentConfig,
} from "./config.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";

export interface EnvCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
}

/** 执行环境配置命令。 */
export async function runEnvCommand(
	subcommand: string | undefined,
	argv: string[],
	context: EnvCommandContext = {},
): Promise<void> {
	const paths = context.paths ?? defaultConfigPaths();
	const log = context.log ?? console.log;
	switch (subcommand) {
		case "list":
			await listEnvironments(argv, paths, log);
			return;
		case "show":
			await showEnvironment(argv, paths, log);
			return;
		case "current":
			await showCurrent(argv, paths, context.processEnv ?? process.env, log);
			return;
		case "add":
			await addEnvironment(argv, paths, log);
			return;
		case "remove":
			await removeEnvironment(argv, paths, log);
			return;
		case "use":
			await useEnvironment(argv, paths, log);
			return;
		default:
			throw new Error(envUsage());
	}
}

function envUsage(): string {
	return [
		"环境命令:",
		"  vcpdeck env list",
		"  vcpdeck env show <name>",
		"  vcpdeck env current [--env=<name>] [--server=<url>]",
		"  vcpdeck env add <name> --server=<url> --auth=password --username=<name> --password-env=<VAR>",
		"  vcpdeck env add <name> --server=<url> --auth=bearer --token-env=<VAR>",
		"  vcpdeck env remove <name>",
		"  vcpdeck env use <name> --global|--local",
	].join("\n");
}

async function listEnvironments(
	argv: string[],
	paths: ConfigPaths,
	log: (message: string) => void,
): Promise<void> {
	assertNoArgs(argv);
	const config = await loadCliConfig(paths.globalConfigPath);
	const names = Object.keys(config.environments).sort((left, right) =>
		left.localeCompare(right, "en"),
	);
	if (!names.length) {
		log("尚未配置环境");
		return;
	}
	for (const name of names) {
		const environment = config.environments[name];
		const marker = config.defaultEnvironment === name ? "*" : " ";
		log(`${marker} ${name}\t${environment.server}\t${authSummary(environment)}`);
	}
}

async function showEnvironment(
	argv: string[],
	paths: ConfigPaths,
	log: (message: string) => void,
): Promise<void> {
	const { positionals } = parseCommandArgs(argv);
	if (positionals.length !== 1) throw new Error("用法: vcpdeck env show <name>");
	const config = await loadCliConfig(paths.globalConfigPath);
	const name = positionals[0];
	const environment = ownEnvironment(config.environments, name);
	if (!environment) throw new Error(`环境不存在: ${name}`);
	log(`环境: ${name}`);
	log(`Server: ${environment.server}`);
	log(`认证: ${authSummary(environment)}`);
	log(`全局默认: ${config.defaultEnvironment === name ? "是" : "否"}`);
	log(`配置: ${paths.globalConfigPath}`);
}

async function showCurrent(
	argv: string[],
	paths: ConfigPaths,
	processEnv: NodeJS.ProcessEnv,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["env", "environment", "server", "username"],
	});
	if (positionals.length) throw new Error("env current 不接受位置参数");
	const env = exclusiveAlias(options, "env", "environment");
	const resolved = await resolveEnvironment({
		environment: env,
		server: stringOption(options, "server"),
		username: stringOption(options, "username"),
		requireCredentials: false,
		paths,
		processEnv,
	});
	log(formatEnvironmentSummary(resolved));
}

async function addEnvironment(
	argv: string[],
	paths: ConfigPaths,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		value: ["server", "auth", "username", "password-env", "token-env"],
	});
	if (positionals.length !== 1) {
		throw new Error(
			"用法: vcpdeck env add <name> --server=... --auth=password|bearer ...",
		);
	}
	const name = positionals[0];
	assertEnvironmentName(name);
	const server = requiredOption(options, "server");
	const auth = requiredOption(options, "auth");
	const environment = buildEnvironment(server, auth, options);
	const config = await loadCliConfig(paths.globalConfigPath);
	if (ownEnvironment(config.environments, name)) {
		throw new Error(`环境已存在: ${name}`);
	}
	config.environments[name] = environment;
	await saveCliConfig(paths.globalConfigPath, config);
	log(`已添加环境 ${name}`);
	log(`Server: ${environment.server}`);
	log(`认证: ${authSummary(environment)}`);
	log(`配置: ${paths.globalConfigPath}`);
}

async function removeEnvironment(
	argv: string[],
	paths: ConfigPaths,
	log: (message: string) => void,
): Promise<void> {
	const { positionals } = parseCommandArgs(argv);
	if (positionals.length !== 1)
		throw new Error("用法: vcpdeck env remove <name>");
	const name = positionals[0];
	const config = await loadCliConfig(paths.globalConfigPath);
	if (!ownEnvironment(config.environments, name)) {
		throw new Error(`环境不存在: ${name}`);
	}
	const environments = Object.fromEntries(
		Object.entries(config.environments).filter(([key]) => key !== name),
	);
	await saveCliConfig(paths.globalConfigPath, {
		version: 1,
		environments,
		...(config.defaultEnvironment && config.defaultEnvironment !== name
			? { defaultEnvironment: config.defaultEnvironment }
			: {}),
	});
	log(`已删除环境 ${name}`);
}

async function useEnvironment(
	argv: string[],
	paths: ConfigPaths,
	log: (message: string) => void,
): Promise<void> {
	const { positionals, options } = parseCommandArgs(argv, {
		boolean: ["global", "local"],
	});
	if (
		positionals.length !== 1 ||
		Boolean(options.global) === Boolean(options.local)
	) {
		throw new Error("用法: vcpdeck env use <name> --global|--local");
	}
	const name = positionals[0];
	const config = await loadCliConfig(paths.globalConfigPath);
	if (!ownEnvironment(config.environments, name)) {
		throw new Error(`环境不存在: ${name}`);
	}
	if (options.global) {
		config.defaultEnvironment = name;
		await saveCliConfig(paths.globalConfigPath, config);
		log(`已将 ${name} 设为全局默认环境`);
		return;
	}
	const target = await localProjectConfigTarget(paths.cwd);
	await saveProjectConfig(target, { version: 1, environment: name });
	log(`已将 ${name} 设为项目默认环境`);
	log(`配置: ${target}`);
}

function buildEnvironment(
	serverValue: string,
	authType: string,
	options: Record<string, string | true>,
): EnvironmentConfig {
	const server = normalizeServerUrl(serverValue);
	if (authType === "password") {
		if (options["token-env"] !== undefined) {
			throw new Error("password 认证不接受 --token-env");
		}
		const username = requiredOption(options, "username");
		const passwordEnv = requiredOption(options, "password-env");
		assertEnvironmentVariableName(passwordEnv);
		return {
			server,
			auth: { type: "password", username, passwordEnv },
		} satisfies PasswordEnvironmentConfig;
	}
	if (authType === "bearer") {
		if (options.username !== undefined || options["password-env"] !== undefined) {
			throw new Error("bearer 认证不接受 --username/--password-env");
		}
		const tokenEnv = requiredOption(options, "token-env");
		assertEnvironmentVariableName(tokenEnv);
		return {
			server,
			auth: { type: "bearer", tokenEnv },
		} satisfies BearerEnvironmentConfig;
	}
	throw new Error("--auth 必须为 password 或 bearer");
}

function ownEnvironment(
	environments: Record<string, EnvironmentConfig>,
	name: string,
): EnvironmentConfig | undefined {
	return Object.hasOwn(environments, name) ? environments[name] : undefined;
}

function authSummary(environment: EnvironmentConfig): string {
	return environment.auth.type === "password"
		? `password (${environment.auth.username}, ${environment.auth.passwordEnv})`
		: `bearer (${environment.auth.tokenEnv})`;
}

function requiredOption(
	options: Record<string, string | true>,
	name: string,
): string {
	const value = stringOption(options, name);
	if (!value) throw new Error(`缺少 --${name}`);
	return value;
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

function assertNoArgs(argv: string[]): void {
	if (argv.length) throw new Error("该命令不接受参数");
}
