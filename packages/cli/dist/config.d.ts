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
export type EnvironmentConfig = PasswordEnvironmentConfig | BearerEnvironmentConfig;
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
export declare function defaultConfigPaths(cwd?: string): ConfigPaths;
/** 规范化并校验 Server URL。 */
export declare function normalizeServerUrl(value: string): string;
export declare function assertEnvironmentName(name: string): void;
export declare function assertEnvironmentVariableName(name: string): void;
/** 严格解析用户级配置，拒绝未知字段和明文秘密。 */
export declare function parseCliConfig(value: unknown): CliConfig;
/** 严格解析项目选择器。 */
export declare function parseProjectConfig(value: unknown): ProjectConfig;
export declare function loadCliConfig(path: string, options?: {
    required?: boolean;
}): Promise<CliConfig>;
export declare function loadProjectConfig(path: string): Promise<ProjectConfig>;
/** 本地选择器写入目标：优先已有最近配置，其次 Git 根，最后当前目录。 */
export declare function localProjectConfigTarget(cwd: string): Promise<string>;
/** 原子写入用户级配置；POSIX 下目录与文件分别限制为 0700/0600。 */
export declare function saveCliConfig(path: string, config: CliConfig): Promise<void>;
/** 原子写入项目级环境选择器。 */
export declare function saveProjectConfig(path: string, config: ProjectConfig): Promise<void>;
/** 从 cwd 向上查找最近项目配置；Git 仓库内最多查到仓库根。 */
export declare function findProjectConfig(cwd: string): Promise<string | undefined>;
