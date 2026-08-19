import {
	assertEnvironmentName,
	type ConfigPaths,
	type EnvironmentConfig,
	defaultConfigPaths,
	findProjectConfig,
	loadCliConfig,
	loadProjectConfig,
	normalizeServerUrl,
} from "./config.js";

/** 环境选择来源。 */
export type EnvironmentSource =
	| { type: "direct" }
	| { type: "flag"; name: string }
	| { type: "environment-variable"; name: string }
	| { type: "project"; name: string; path: string }
	| { type: "global-default"; name: string; path: string };

/** 不含秘密值的认证摘要。 */
type ResolvedAuthSummary =
	| {
			type: "password";
			username: string;
			credentialEnv: string;
	  }
	| {
			type: "bearer";
			credentialEnv: string;
	  };

/** 不含秘密值的环境解析摘要。 */
export interface ResolvedEnvironmentSummary {
	name: string | null;
	server: string;
	auth: ResolvedAuthSummary;
	source: EnvironmentSource;
}

/** 业务命令使用的环境；秘密只在本进程内存中。 */
export type ResolvedEnvironment = ResolvedEnvironmentSummary & {
	credentials?:
		| { type: "password"; username: string; password: string }
		| { type: "bearer"; token: string };
};

/** 环境解析输入。 */
export interface ResolveEnvironmentOptions {
	environment?: string;
	server?: string;
	username?: string;
	password?: string;
	requireCredentials?: boolean;
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
}

/**
 * 解析顺序：--server 直连；否则 --env → VCPDECK_ENVIRONMENT → 最近项目配置 → 全局默认。
 * 项目配置损坏或引用不存在环境时 fail closed，不回退到全局默认。
 */
export async function resolveEnvironment(
	options: ResolveEnvironmentOptions = {},
): Promise<ResolvedEnvironment> {
	const paths = options.paths ?? defaultConfigPaths();
	const processEnv = options.processEnv ?? process.env;
	if (options.server && options.environment) {
		throw new Error("--server 与 --env/--environment 不能同时使用");
	}
	if (options.server) {
		return resolveDirectEnvironment(options, processEnv);
	}

	const globalConfig = await loadCliConfig(paths.globalConfigPath);
	let source: EnvironmentSource;
	let name: string | undefined;
	if (options.environment) {
		name = options.environment;
		source = { type: "flag", name };
	} else if (processEnv.VCPDECK_ENVIRONMENT) {
		name = processEnv.VCPDECK_ENVIRONMENT;
		source = { type: "environment-variable", name };
	} else {
		const projectPath = await findProjectConfig(paths.cwd);
		if (projectPath) {
			const project = await loadProjectConfig(projectPath);
			name = project.environment;
			source = { type: "project", name, path: projectPath };
		} else if (globalConfig.defaultEnvironment) {
			name = globalConfig.defaultEnvironment;
			source = {
				type: "global-default",
				name,
				path: paths.globalConfigPath,
			};
		} else {
			throw new Error(
				"未选择 VCPDeck 环境：使用 --env、VCPDECK_ENVIRONMENT、项目 .vcpdeck.json 或全局默认环境",
			);
		}
	}

	assertEnvironmentName(name);
	const environment = Object.hasOwn(globalConfig.environments, name)
		? globalConfig.environments[name]
		: undefined;
	if (!environment) {
		throw new Error(`环境不存在: ${name}（配置: ${paths.globalConfigPath}）`);
	}
	return resolveRegisteredEnvironment({
		name,
		environment,
		source,
		processEnv,
		requireCredentials: options.requireCredentials ?? true,
	});
}

/** 返回适合终端展示的来源。 */
function environmentSourceLabel(source: EnvironmentSource): string {
	switch (source.type) {
		case "direct":
			return "--server 直连";
		case "flag":
			return `--env=${source.name}`;
		case "environment-variable":
			return `VCPDECK_ENVIRONMENT=${source.name}`;
		case "project":
			return source.path;
		case "global-default":
			return `${source.path}（全局默认）`;
		default:
			throw new Error("未知环境来源");
	}
}

/** 返回不含秘密值的多行环境摘要。 */
export function formatEnvironmentSummary(
	environment: ResolvedEnvironmentSummary,
): string {
	const lines = [
		`环境: ${environment.name ?? "direct"}`,
		`Server: ${environment.server}`,
		`来源: ${environmentSourceLabel(environment.source)}`,
	];
	if (environment.auth.type === "password") {
		lines.push(
			`认证: password (${environment.auth.username}, ${environment.auth.credentialEnv})`,
		);
	} else {
		lines.push(`认证: bearer (${environment.auth.credentialEnv})`);
	}
	return lines.join("\n");
}

function resolveDirectEnvironment(
	options: ResolveEnvironmentOptions,
	processEnv: NodeJS.ProcessEnv,
): ResolvedEnvironment {
	const username = options.username ?? processEnv.VCPDECK_ADMIN_USERNAME;
	const password = options.password ?? processEnv.VCPDECK_ADMIN_PASSWORD;
	const requireCredentials = options.requireCredentials ?? true;
	if (requireCredentials && (!username || !password)) {
		throw new Error(
			"直连模式需要 --username/--password 或 VCPDECK_ADMIN_USERNAME/VCPDECK_ADMIN_PASSWORD",
		);
	}
	const environment: ResolvedEnvironment = {
		name: null,
		server: normalizeServerUrl(options.server as string),
		auth: {
			type: "password",
			username: username ?? "<未设置>",
			credentialEnv: "VCPDECK_ADMIN_PASSWORD",
		},
		source: { type: "direct" },
	};
	if (username && password) {
		environment.credentials = { type: "password", username, password };
	}
	return environment;
}

function resolveRegisteredEnvironment(options: {
	name: string;
	environment: EnvironmentConfig;
	source: EnvironmentSource;
	processEnv: NodeJS.ProcessEnv;
	requireCredentials: boolean;
}): ResolvedEnvironment {
	const { name, environment, source, processEnv, requireCredentials } = options;
	if (environment.auth.type === "password") {
		const password = processEnv[environment.auth.passwordEnv];
		if (requireCredentials && !password) {
			throw new Error(
				`环境 ${name} 缺少凭据变量: ${environment.auth.passwordEnv}`,
			);
		}
		const resolved: ResolvedEnvironment = {
			name,
			server: environment.server,
			auth: {
				type: "password",
				username: environment.auth.username,
				credentialEnv: environment.auth.passwordEnv,
			},
			source,
		};
		if (password) {
			resolved.credentials = {
				type: "password",
				username: environment.auth.username,
				password,
			};
		}
		return resolved;
	}

	const token = processEnv[environment.auth.tokenEnv];
	if (requireCredentials && !token) {
		throw new Error(`环境 ${name} 缺少凭据变量: ${environment.auth.tokenEnv}`);
	}
	const resolved: ResolvedEnvironment = {
		name,
		server: environment.server,
		auth: { type: "bearer", credentialEnv: environment.auth.tokenEnv },
		source,
	};
	if (token) resolved.credentials = { type: "bearer", token };
	return resolved;
}
