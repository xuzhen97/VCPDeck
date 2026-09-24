/**
 * 旧 Session 显式导入：发现、预览、唯一解析（ADR-0031；设计 §21.3 步骤 1–3 的读取侧）。
 *
 * 边界（ADR-0031 决策 2）：
 * - 源根固定为 `<home>/.pi/agent/sessions`，不接受参数覆盖（杜绝「把任意目录当源读取」）；
 * - 对源目录**只读**：不修改、不删除、不改名、不移动；不跟随符号链接（防逃出源根）；
 * - 摘要不含正文、不含单个会话文件的完整绝对路径（sourceRoot 与 cwd 属设计允许的元数据）；
 * - 标识只用纯文件名，同名歧义即 fail closed（返回 null）。
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import {
	MAX_PREVIEW_CODE_POINTS,
	type PiImportListResponse,
	type PiImportPreviewResponse,
	type PiImportRunResponse,
	type PiImportRunResult,
	type PiImportSessionSummary,
} from "@vcpdeck/shared";
import { loadOrCreateInstallSecret, sessionNamespaceFor } from "./install-secret.js";
import { canonicalPath } from "./project-path.js";

/** 源根固定为用户原生 Pi 会话目录；不接受参数覆盖（ADR-0031 决策 2）。 */
export function nativeSessionRoot(): string {
	return join(homedir(), ".pi", "agent", "sessions");
}

export interface ImportFindDeps {
	sourceRoot: string;
	/** 允许的项目根（`discoverRoots()` 同源）。 */
	roots: string[];
	/** 该源是否已存在目标副本（由 T4 的 targetPathFor 实现注入）。 */
	isImported: (sourceName: string, cwd: string | null) => Promise<boolean>;
}

export interface ImportSourceDeps {
	sourceRoot: string;
}

interface NativeSessionFile {
	file: string;
	label: string;
}

/** cwd 是否落在允许根内（两侧都经 canonicalPath 统一规范化；剥尾斜杠兼容盘符根 `c:/`）。 */
function isUnderRoots(cwd: string | null, roots: string[]): boolean {
	if (!cwd) return false;
	const target = canonicalPath(cwd);
	return roots.some((root) => {
		let base = canonicalPath(root);
		while (base.length > 1 && base.endsWith("/")) base = base.slice(0, -1);
		if (base === "/") return target.startsWith("/");
		return target === base || target.startsWith(`${base}/`);
	});
}

/** 递归收集源根下所有普通文件的 `*.jsonl`；不跟随符号链接（防逃逸）。 */
async function collectJsonlFiles(
	sourceRoot: string,
	dir = sourceRoot,
): Promise<NativeSessionFile[]> {
	let dirents;
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch {
		return []; // 源根不存在 → 空列表（不是错误）
	}
	const files: NativeSessionFile[] = [];
	for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(dir, dirent.name);
		if (dirent.isSymbolicLink()) continue;
		if (dirent.isDirectory()) {
			files.push(...(await collectJsonlFiles(sourceRoot, full)));
		} else if (dirent.isFile() && dirent.name.endsWith(".jsonl")) {
			files.push({
				file: full,
				label: relative(sourceRoot, full).split(sep).join("/"),
			});
		}
	}
	return files;
}

/**
 * 纯 fs 只读读取会话 JSONL 的元数据与首条 user 文本；解析失败抛错（调用方判 unreadable）。
 *
 * **刻意不使用 `SessionManager.open`**：实测它会就地改写文件（version 迁移 + entry id 重写），
 * 连“只读列元数据”都会修改用户原生 Pi 数据，直接违反 ADR-0031 决策 3 与零污染门禁。
 * （SDK 打开我们的副本做格式迁移是允许的，那是“只操作副本”的一部分。）
 */
async function readNativeSessionJsonl(file: string): Promise<{
	entryCount: number;
	startedAt: string | null;
	cwd: string;
	firstUserText: string;
}> {
	const raw = await readFile(file, "utf8");
	const lines = raw
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
	if (lines.length === 0) throw new Error("空会话文件");

	// 首行必须是带 cwd 的 header（形状见 session-manager.d.ts 的会话头类型）
	const header = JSON.parse(lines[0]) as Record<string, unknown>;
	if (typeof header !== "object" || header === null || typeof header.cwd !== "string" || header.cwd.length === 0) {
		throw new Error("会话 header 缺少 cwd");
	}

	let entryCount = 0;
	let startedAt: string | null = null;
	let firstUserText = "";
	let firstText = "";
	for (const line of lines.slice(1)) {
		// 任一 entry 行解析失败 → 整体抛错（文件不可信 → unreadable）
		const entry = JSON.parse(line) as Record<string, unknown>;
		entryCount += 1;
		if (
			startedAt === null &&
			typeof entry.timestamp === "string" &&
			!Number.isNaN(Date.parse(entry.timestamp))
		) {
			startedAt = entry.timestamp;
		}
		if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) {
			continue;
		}
		const text = messageText(entry.message);
		if (!firstText && text) firstText = text;
		if ((entry.message as { role?: unknown }).role === "user" && text && !firstUserText) {
			firstUserText = text;
		}
	}
	if (startedAt === null) {
		startedAt =
			(await stat(file).then((info) => info.mtime.toISOString()).catch(() => null)) ?? null;
	}
	return {
		entryCount,
		startedAt,
		cwd: header.cwd,
		firstUserText: firstUserText || firstText,
	};
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

/**
 * 列出源根下会话的元数据摘要（递归收集；`list` 不递归的事实见 T1 执行记录）。
 * 每条独立判定 imported / cwdNotAllowed / unreadable，单条失败不影响其它条目。
 */
export async function collectImportableSessions(
	deps: ImportFindDeps,
): Promise<PiImportListResponse> {
	const files = await collectJsonlFiles(deps.sourceRoot);
	const sessions: PiImportSessionSummary[] = [];
	for (const { file, label } of files) {
		const sourceName = label.slice(label.lastIndexOf("/") + 1);
		const sourceLabel = label;
		try {
			const meta = await readNativeSessionJsonl(file);
			sessions.push({
				sourceName,
				sourceLabel,
				startedAt: meta.startedAt,
				entryCount: meta.entryCount,
				cwd: meta.cwd,
				imported: await deps.isImported(sourceName, meta.cwd),
				cwdNotAllowed: !isUnderRoots(meta.cwd, deps.roots),
				unreadable: false,
			});
		} catch {
			// 损坏/版本不兼容：仍然列出，但不可勾选、run 时拒绝
			const mtime = await stat(file).then((info) => info.mtime.toISOString()).catch(() => null);
			sessions.push({
				sourceName,
				sourceLabel,
				startedAt: mtime,
				entryCount: 0,
				cwd: null,
				imported: false,
				cwdNotAllowed: true,
				unreadable: true,
			});
		}
	}

	return { sourceRoot: deps.sourceRoot, sessions };
}

/** 按纯文件名在源根内找**唯一**匹配；0 或 ≥2 个匹配返回 null（fail closed）。 */
export async function resolveNativeSessionFile(
	sourceName: string,
	deps: ImportSourceDeps,
): Promise<NativeSessionFile | null> {
	const files = await collectJsonlFiles(deps.sourceRoot);
	const matched = files.filter(
		(entry) => entry.label.slice(entry.label.lastIndexOf("/") + 1) === sourceName,
	);
	return matched.length === 1 ? matched[0] : null;
}

/**
 * 逐条显式预览：取首条 user 消息文本（无则首条 message 文本，仍无则空串），
 * 按 Unicode code point 截到 `MAX_PREVIEW_CODE_POINTS`。
 * 找不到或读取失败返回 null（调用方映射为 `PI_SESSION_NOT_FOUND`）。
 */
export async function previewNativeSession(
	sourceName: string,
	deps: ImportSourceDeps,
): Promise<PiImportPreviewResponse | null> {
	const resolved = await resolveNativeSessionFile(sourceName, deps);
	if (!resolved) return null;
	try {
		const meta = await readNativeSessionJsonl(resolved.file);
		const codePoints = [...meta.firstUserText];
		return {
			sourceName,
			previewText: codePoints.slice(0, MAX_PREVIEW_CODE_POINTS).join(""),
			truncated: codePoints.length > MAX_PREVIEW_CODE_POINTS,
		};
	} catch {
		return null;
	}
}

/** 导入执行依赖：源根、允许根、目标 Session 根与安装级 secret 路径。 */
export interface ImportRunDeps {
	sourceRoot: string;
	/** 允许的项目根（`discoverRoots()` 同源）。 */
	roots: string[];
	/** VCPDeck Session 根（`<dataRoot>/pi/sessions`）。 */
	sessionsRoot: string;
	/** 安装级持久 secret 路径（Session namespace 派生用）。 */
	installSecretPath: string;
	/** 副本可解析校验（默认用 SDK 只读 open；测试可注入以模拟损坏副本）。 */
	verifyTarget?: (file: string, dir: string) => void;
}

/**
 * 计算导入目标：`<sessionsRoot>/<sessionNamespaceFor(canonicalPath(cwd), installSecret)>/<sourceName>`。
 * namespace 按会话记录的 cwd 派生，与该会话原属项目的新建会话同源（设计 §21.3 步骤 4）。
 */
export async function targetPathFor(
	cwd: string,
	sourceName: string,
	deps: ImportRunDeps,
): Promise<{ dir: string; file: string }> {
	const secret = await loadOrCreateInstallSecret(deps.installSecretPath);
	const dir = join(
		deps.sessionsRoot,
		sessionNamespaceFor(canonicalPath(cwd), secret),
	);
	await mkdir(dir, { recursive: true });
	return { dir, file: join(dir, sourceName) };
}

/** 单条导入：只读打开 → 独立 cwd 校验 → 单向复制（`wx` 幂等）→ 副本校验（失败清理）。 */
async function importOne(
	sourceName: string,
	deps: ImportRunDeps,
): Promise<PiImportRunResult> {
	const resolved = await resolveNativeSessionFile(sourceName, {
		sourceRoot: deps.sourceRoot,
	});
	if (!resolved) {
		return { sourceName, status: "rejected", reasonCode: "PI_SESSION_NOT_FOUND" };
	}

	let cwd: string;
	try {
		// §21.3 步骤 2：只读读取源（纯 fs 自解析，绝不改写源文件）
		const meta = await readNativeSessionJsonl(resolved.file);
		cwd = meta.cwd;
	} catch {
		return { sourceName, status: "rejected", reasonCode: "PI_SESSION_NOT_FOUND" };
	}

	// §21.3 步骤 3：run 端独立再校验（不信任 list 的标记，防绕过）
	if (!isUnderRoots(cwd, deps.roots)) {
		return { sourceName, status: "rejected", reasonCode: "PI_PROJECT_NOT_ALLOWED" };
	}

	const target = await targetPathFor(cwd, sourceName, deps);
	try {
		// §21.3 步骤 4：单向复制；`flag: "wx"` 天然不覆盖（步骤 5 幂等）
		await writeFile(target.file, await readFile(resolved.file), { flag: "wx" });
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST") {
			return { sourceName, status: "alreadyImported" };
		}
		return { sourceName, status: "rejected", reasonCode: "PI_CONFIG_UNAVAILABLE" };
	}

	try {
		if (deps.verifyTarget) {
			deps.verifyTarget(target.file, target.dir);
		} else {
			// 副本可解析校验：同样用纯 fs 自解析（对我们的副本也不需要 SDK open）
			await readNativeSessionJsonl(target.file);
		}
	} catch {
		await rm(target.file, { force: true }); // 清理半成品，不留残缺副本
		return { sourceName, status: "rejected", reasonCode: "PI_CONFIG_UNAVAILABLE" };
	}
	return { sourceName, status: "imported" };
}

/**
 * 批量导入（§21.3 步骤 2–6）：逐条独立执行与独立结果，不整体回滚。
 * 源文件全程只读：不修改、不删除、不改名、不移动（零污染门禁断言）。
 */
export async function importNativeSessions(
	sourceNames: string[],
	deps: ImportRunDeps,
): Promise<PiImportRunResponse> {
	// 运行时护栏：envelope 校验在 REST 入口；这里再拦一道，
	// 避免字符串被按字符迭代、非字符串流入后续路径（防御性 fail closed）。
	if (
		!Array.isArray(sourceNames) ||
		sourceNames.some((name) => typeof name !== "string")
	) {
		throw Object.assign(new Error("sourceNames 必须是字符串数组"), {
			code: "PI_PROTOCOL_INVALID",
		});
	}
	const results: PiImportRunResult[] = [];
	for (const sourceName of sourceNames) {
		results.push(await importOne(sourceName, deps));
	}
	return { results };
}
