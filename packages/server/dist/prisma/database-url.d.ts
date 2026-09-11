/** 解析 Server 使用的数据库地址，未覆盖时使用开发库。 */
export declare function resolveDatabaseUrl(databaseUrl?: string | undefined, cwd?: string): string;
