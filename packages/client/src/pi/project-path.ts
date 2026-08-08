import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { randomBytes, createHmac } from "node:crypto";
import type { PiCwdRef } from "@vcpdeck/shared";

/** 稳定的项目路径错误（与 @vcpdeck/shared PiErrorCode 对齐） */
export function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

export function canonicalPath(p: string): string {
	const s = resolve(p).replace(/\\/g, "/");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

function samePath(a: string, b: string): boolean {
	return canonicalPath(a) === canonicalPath(b);
}

/**
 * 进程级随机 secret：同一 Client 进程内 projectKey 稳定，重启后变化。
 * 只用于 HMAC 计算，绝不外传。
 */
let processSecret: string | null = null;
function getProcessSecret(): string {
	if (!processSecret) processSecret = randomBytes(32).toString("hex");
	return processSecret;
}

/**
 * 计算项目不透明 key：HMAC-SHA-256(canonicalPath, processSecret)。
 * 相同 canonical cwd 的别名得到同 key；不同 cwd 不同；Client 重启后改变。
 */
export function projectKeyFor(
	canonicalPath: string,
	secret: string = getProcessSecret(),
): string {
	return createHmac("sha256", secret).update(canonicalPath).digest("hex");
}

/**
 * 将 Files roots 选择的目录解析为 canonical cwd + 不透明 projectKey。
 * - 请求的 root 必须属于允许 roots（realpath 解析）；
 * - 目标目录 realpath 后必须仍在 root 内（防 symlink 逃逸）；
 * - 目标必须是目录；
 * - Windows 下 canonical 比较大小写不敏感。
 * 不复用会吞掉自身异常的 resolveSafePath()。
 */
export async function resolveProjectCwd(
	ref: PiCwdRef,
	roots: string[],
): Promise<{ cwd: string; key: string }> {
	const requestedRoot = await realpath(resolve(ref.rootDir)).catch(() => {
		throw piError("PI_PROJECT_NOT_ALLOWED", "Project root is not accessible");
	});
	const allowed = await Promise.all(
		roots.map((root) => realpath(resolve(root)).catch(() => "")),
	);
	if (!allowed.some((root) => root !== "" && samePath(root, requestedRoot))) {
		throw piError("PI_PROJECT_NOT_ALLOWED", "Project root is not allowed");
	}

	const cwd = await realpath(resolve(requestedRoot, ref.relativePath)).catch(
		() => {
			throw piError("PI_PROJECT_NOT_ALLOWED", "Project path is not accessible");
		},
	);
	const rel = relative(requestedRoot, cwd);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw piError("PI_PROJECT_NOT_ALLOWED", "Project path escapes root");
	}
	const st = await stat(cwd).catch(() => {
		throw piError("PI_PROJECT_NOT_ALLOWED", "Project path is not accessible");
	});
	if (!st.isDirectory()) {
		throw piError("PI_PROJECT_NOT_ALLOWED", "Project path must be a directory");
	}

	return { cwd, key: projectKeyFor(canonicalPath(cwd)) };
}
