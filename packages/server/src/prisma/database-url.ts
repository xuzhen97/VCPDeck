import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** 解析 Server 使用的数据库地址，未覆盖时使用开发库。 */
export function resolveDatabaseUrl(
	databaseUrl = process.env.DATABASE_URL,
	cwd = process.cwd(),
): string {
	if (!databaseUrl || databaseUrl === "file:./dev.db") {
		return pathToFileURL(path.join(cwd, "prisma", "dev.db")).href;
	}
	return databaseUrl;
}
