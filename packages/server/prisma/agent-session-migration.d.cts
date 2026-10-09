/**
 * Agent 会话/执行/审计显式迁移的类型声明(ADR-0041)。
 * 实现是 CommonJS(.cjs,Server 启动与安装脚本共用),此处只声明公开接口。
 */
export interface AgentMigrationOptions {
	/** SQLite DATABASE_URL(libsql 格式)。 */
	url: string;
	/** migration.sql 绝对路径。 */
	sqlPath: string;
}

export interface AgentMigrationResult {
	migratedSessions: number;
	alreadyApplied: boolean;
}

export declare class AgentMigrationBlockedError extends Error {
	code: "AGENT_MIGRATION_BLOCKED";
}

export declare const MIGRATION_VERSION: string;
export declare function migrateAgentSessions(options: AgentMigrationOptions): Promise<AgentMigrationResult>;
export declare function assertAgentMigrationReady(options: AgentMigrationOptions): Promise<void>;
/** 解析 CLI 入口的数据库地址:显式 DATABASE_URL 优先,否则回退 Prisma config 的开发库。 */
export declare function resolveCliDatabaseUrl(
	env?: { DATABASE_URL?: string },
	serverRoot?: string | null,
): string;
/**
 * 定位迁移 SQL:同时兼容源码布局与发布构件布局(构件中 SQL 与脚本同目录)。
 * 均不存在时抛出 AGENT_MIGRATION_BLOCKED 并列出已查找路径。
 */
export declare function resolveMigrationSqlPath(baseDir?: string): string;
/** 定位 prisma.config.cjs;不存在时返回 null(调用方退回内置默认值)。 */
export declare function resolvePrismaConfigPath(baseDir?: string): string | null;
