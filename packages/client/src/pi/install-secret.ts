/**
 * VCPDeck 安装级 secret 与 Session namespace 派生。
 *
 * 两种 key 刻意分离（设计 §10）：
 * - Run 锁 projectKey：进程级随机 secret，重启即变，只用于 Server 内存锁与 state 对账；
 * - Session namespace：安装级持久 secret，重启与 Release 更新后稳定，用作 sessions/<namespace>。
 *
 * 两者共用 projectKeyFor()，只是 secret 不同。
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { piError, projectKeyFor } from "./project-path.js";

const HEX_SECRET_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 读取或创建安装级 secret（32 字节 hex，0600）。
 * 内容非法时 fail closed 且不覆盖原文件（不静默重新生成，避免已有 Session 目录失联）。
 */
export async function loadOrCreateInstallSecret(
	filePath: string,
): Promise<string> {
	try {
		const raw = (await readFile(filePath, "utf8")).trim();
		if (!HEX_SECRET_PATTERN.test(raw)) {
			throw piError("PI_CONFIG_UNAVAILABLE", "install-secret 内容非法");
		}
		return raw;
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
		const created = randomBytes(32).toString("hex");
		try {
			await writeFile(filePath, `${created}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			return created;
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
			const raw = (await readFile(filePath, "utf8")).trim();
			if (!HEX_SECRET_PATTERN.test(raw)) {
				throw piError("PI_CONFIG_UNAVAILABLE", "install-secret 内容非法");
			}
			return raw;
		}
}

/**
 * Session 目录名：由 canonical cwd 与安装级 secret 派生，稳定且不泄露 cwd。
 * 与 Run 锁 projectKey 使用同一函数但不同 secret。
 */
export function sessionNamespaceFor(
	canonicalPath: string,
	secret: string,
): string {
	return projectKeyFor(canonicalPath, secret);
}
