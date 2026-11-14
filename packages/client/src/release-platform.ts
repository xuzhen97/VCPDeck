import { existsSync } from "node:fs";
import type { ReleasePlatform } from "@vcpdeck/shared";

/** libc 判定结论；unknown 表示没有可信证据，既不能当 glibc 也不能当 musl。 */
export type LibcKind = "glibc" | "musl" | "unknown";

/** 用于 libc 判定的系统事实；生产由 readLibcFacts 采集，测试可注入。 */
export interface LibcFacts {
	/** process.report 的 header.glibcVersionRuntime；存在即证明运行在 glibc 上。 */
	glibcVersionRuntime?: unknown;
	/** 是否存在 musl 动态加载器。 */
	muslLoader?: boolean;
	/** 是否存在 glibc 动态加载器。 */
	glibcLoader?: boolean;
}

const MUSL_LOADERS = ["/lib/ld-musl-x86_64.so.1", "/lib64/ld-musl-x86_64.so.1"];
const GLIBC_LOADERS = ["/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"];

/** 判断给定路径中是否至少存在一个（读取失败视为不存在）。 */
function anyExists(paths: readonly string[]): boolean {
	return paths.some((path) => {
		try {
			return existsSync(path);
		} catch {
			return false;
		}
	});
}

/** 采集本机 libc 事实：先取 process.report，再检查动态加载器文件。 */
export function readLibcFacts(): LibcFacts {
	let glibcVersionRuntime: unknown;
	if (typeof process.report?.getReport === "function") {
		try {
			const report = process.report.getReport() as {
				header?: { glibcVersionRuntime?: unknown };
			};
			glibcVersionRuntime = report.header?.glibcVersionRuntime;
		} catch {
			glibcVersionRuntime = undefined;
		}
	}
	return {
		glibcVersionRuntime,
		muslLoader: anyExists(MUSL_LOADERS),
		glibcLoader: anyExists(GLIBC_LOADERS),
	};
}

/** 依据事实判定 libc；缺 glibc 字段不等于 musl，必须有 musl 加载器证据。 */
export function detectLibc(facts: LibcFacts = readLibcFacts()): LibcKind {
	if (typeof facts.glibcVersionRuntime === "string" && facts.glibcVersionRuntime !== "") {
		return "glibc";
	}
	if (facts.muslLoader === true) return "musl";
	if (facts.glibcLoader === true) return "glibc";
	return "unknown";
}

/** 发布平台探测输入。 */
export interface ReleasePlatformInput {
	platform: string;
	arch: string;
	libc: LibcKind;
}

/**
 * 依据真实运行事实判定可上报的发布平台（ADR-0065）。
 * 只认 x64；无法证明 libc 时返回 undefined（未报告），绝不猜测。
 */
export function detectReleasePlatform(input: ReleasePlatformInput): ReleasePlatform | undefined {
	if (input.arch !== "x64") return undefined;
	if (input.platform === "win32") return "win-x64";
	if (input.platform !== "linux") return undefined;
	if (input.libc === "musl") return "linux-x64-musl";
	if (input.libc === "glibc") return "linux-x64";
	return undefined;
}
