import type { PiCwdRef } from "@vcpdeck/shared";
/** 稳定的项目路径错误（与 @vcpdeck/shared PiErrorCode 对齐） */
export declare function piError(code: string, message: string): Error;
export declare function canonicalPath(p: string): string;
/**
 * 计算项目不透明 key：HMAC-SHA-256(canonicalPath, processSecret)。
 * 相同 canonical cwd 的别名得到同 key；不同 cwd 不同；Client 重启后改变。
 */
export declare function projectKeyFor(canonicalPath: string, secret?: string): string;
/**
 * 将 Files roots 选择的目录解析为 canonical cwd + 不透明 projectKey。
 * - 请求的 root 必须属于允许 roots（realpath 解析）；
 * - 目标目录 realpath 后必须仍在 root 内（防 symlink 逃逸）；
 * - 目标必须是目录；
 * - Windows 下 canonical 比较大小写不敏感。
 * 不复用会吞掉自身异常的 resolveSafePath()。
 */
export declare function resolveProjectCwd(ref: PiCwdRef, roots: string[]): Promise<{
    cwd: string;
    key: string;
}>;
