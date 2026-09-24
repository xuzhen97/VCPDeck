import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ImportRunDeps,
	collectImportableSessions,
	importNativeSessions,
	nativeSessionRoot,
	previewNativeSession,
	resolveNativeSessionFile,
} from "./native-session-import.js";
import { loadOrCreateInstallSecret } from "./install-secret.js";
import { sessionNamespaceFor } from "./install-secret.js";
import { canonicalPath } from "./project-path.js";

const USER_PROMPT = "第一个问题 hello world";

async function writeSession(
	dir: string,
	name: string,
	options: { cwd?: string; prompt?: string } = {},
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const lines = [
		{
			type: "session",
			version: 1,
			id: name.replace(/\.jsonl$/, ""),
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: options.cwd ?? "/proj/a",
		},
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-09-01T00:00:01.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: options.prompt ?? USER_PROMPT }],
			},
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-09-01T00:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "回答" }] },
		},
	];
	const file = join(dir, name);
	await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
	return file;
}

/** 2 条正常（嵌套 + 扁平）+ 1 条越根 + 1 条损坏 + 2 个同名（歧义）。 */
async function makeTree() {
	const sourceRoot = await mkdtemp(join(tmpdir(), "vcp-src-"));
	const projectDir = await mkdtemp(join(tmpdir(), "vcp-proj-"));
	const nestedFile = await writeSession(join(sourceRoot, "--d--proj--"), "nested_a.jsonl", {
		cwd: projectDir,
	});
	await writeSession(sourceRoot, "flat_b.jsonl", { cwd: projectDir, prompt: "别的正文文本" });
	await writeSession(sourceRoot, "foreign_c.jsonl", { cwd: "/elsewhere/secret" });
	await writeFile(join(sourceRoot, "broken_d.jsonl"), "{ not json\n", "utf8");
	await writeSession(join(sourceRoot, "dir-a"), "dup.jsonl", { cwd: projectDir });
	await writeSession(join(sourceRoot, "dir-b"), "dup.jsonl", { cwd: projectDir });
	return { sourceRoot, projectDir, nestedFile };
}

describe("collectImportableSessions（元数据摘要）", () => {
	it("摘要可识别状态齐全，且 canary：不含正文、不含源文件完整绝对路径", async () => {
		const { sourceRoot, projectDir, nestedFile } = await makeTree();
		const list = await collectImportableSessions({
			sourceRoot,
			roots: [projectDir],
			isImported: async (name) => name === "flat_b.jsonl",
		});

		const raw = JSON.stringify(list);
		expect(raw).not.toContain(USER_PROMPT); // 正文不出现
		expect(raw).not.toContain(nestedFile); // 单个会话文件的完整绝对路径不出现

		expect(list.sessions).toHaveLength(6);
		const nested = list.sessions.find((item) => item.sourceName === "nested_a.jsonl");
		expect(nested).toMatchObject({
			sourceLabel: "--d--proj--/nested_a.jsonl",
			startedAt: "2026-09-01T00:00:01.000Z",
			entryCount: 2,
			cwdNotAllowed: false,
			unreadable: false,
		});
		expect(nested?.cwd?.replace(/\\/g, "/").endsWith("/vcp-proj-") || nested?.cwd?.includes("vcp-proj")).toBe(true);

		expect(list.sessions.find((item) => item.sourceName === "flat_b.jsonl")?.imported).toBe(true);
		expect(list.sessions.find((item) => item.sourceName === "foreign_c.jsonl")).toMatchObject({
			cwdNotAllowed: true,
			unreadable: false,
		});
		expect(list.sessions.find((item) => item.sourceName === "broken_d.jsonl")).toMatchObject({
			unreadable: true,
		});
		expect(list.sourceRoot).toBe(sourceRoot);
	});

	it("源根不存在返回空列表（不是错误）", async () => {
		const missing = join(tmpdir(), "vcp-missing-root", String(Date.now()));
		const list = await collectImportableSessions({
			sourceRoot: missing,
			roots: [],
			isImported: async () => false,
		});
		expect(list.sessions).toEqual([]);
	});
});

describe("resolveNativeSessionFile（唯一匹配，fail closed）", () => {
	it("嵌套会话按纯文件名唯一解析", async () => {
		const { sourceRoot, nestedFile } = await makeTree();
		const resolved = await resolveNativeSessionFile("nested_a.jsonl", { sourceRoot });
		expect(resolved).toEqual({
			file: nestedFile,
			label: "--d--proj--/nested_a.jsonl",
		});
	});

	it("同名歧义与找不到都返回 null", async () => {
		const { sourceRoot } = await makeTree();
		expect(await resolveNativeSessionFile("dup.jsonl", { sourceRoot })).toBeNull();
		expect(await resolveNativeSessionFile("missing.jsonl", { sourceRoot })).toBeNull();
	});
});

describe("previewNativeSession（逐条显式预览）", () => {
	it("取首条 user 文本，短文本不截断", async () => {
		const { sourceRoot } = await makeTree();
		const preview = await previewNativeSession("nested_a.jsonl", { sourceRoot });
		expect(preview?.previewText).toBe(USER_PROMPT);
		expect(preview?.truncated).toBe(false);
	});

	it("超长文本按 code point 截到 80 并标 truncated", async () => {
		const { sourceRoot } = await makeTree();
		const long = "汉".repeat(100);
		await writeSession(sourceRoot, "long_e.jsonl", { prompt: long });

		const preview = await previewNativeSession("long_e.jsonl", { sourceRoot });
		expect([...(preview?.previewText ?? "")]).toHaveLength(80);
		expect(preview?.truncated).toBe(true);
	});

	it("损坏与找不到都返回 null（不抛给调用方）", async () => {
		const { sourceRoot } = await makeTree();
		expect(await previewNativeSession("broken_d.jsonl", { sourceRoot })).toBeNull();
		expect(await previewNativeSession("missing.jsonl", { sourceRoot })).toBeNull();
	});
});

describe("nativeSessionRoot（源根固定，不可覆盖）", () => {
	it("固定为 <home>/.pi/agent/sessions", () => {
		expect(nativeSessionRoot().replace(/\\/g, "/")).toMatch(
			/\/\.pi\/agent\/sessions$/,
		);
	});
});

describe("importNativeSessions（幂等 / 复制 / 校验 / 清理 / 批量）", () => {
	async function makeRunEnv() {
		const { sourceRoot, projectDir, nestedFile } = await makeTree();
		const sessionsRoot = await mkdtemp(join(tmpdir(), "vcp-sess-"));
		const secretPath = join(await mkdtemp(join(tmpdir(), "vcp-secret-")), "install-secret");
		const deps: ImportRunDeps = {
			sourceRoot,
			roots: [projectDir],
			sessionsRoot,
			installSecretPath: secretPath,
		};
		return { deps, sourceRoot, projectDir, sessionsRoot, nestedFile };
	}

	async function targetFor(deps: ImportRunDeps, cwd: string, name: string): Promise<string> {
		const secret = await loadOrCreateInstallSecret(deps.installSecretPath);
		return join(deps.sessionsRoot, sessionNamespaceFor(canonicalPath(cwd), secret), name);
	}

	it("成功导入 → 幂等二次导入 alreadyImported，目标内容与源都不变", async () => {
		const { deps, sourceRoot, projectDir, nestedFile } = await makeRunEnv();
		const sourceHash = createHash("sha256").update(await readFile(nestedFile)).digest("hex");

		const first = await importNativeSessions(["nested_a.jsonl"], deps);
		expect(first.results[0]).toEqual({ sourceName: "nested_a.jsonl", status: "imported" });

		const target = await targetFor(deps, projectDir, "nested_a.jsonl");
		expect(existsSync(target)).toBe(true);
		const hashAfterFirst = createHash("sha256").update(await readFile(target)).digest("hex");

		const second = await importNativeSessions(["nested_a.jsonl"], deps);
		expect(second.results[0]?.status).toBe("alreadyImported");
		expect(createHash("sha256").update(await readFile(target)).digest("hex")).toBe(hashAfterFirst);
		// 源文件全程只读（ADR-0031 决策 3）
		expect(createHash("sha256").update(await readFile(nestedFile)).digest("hex")).toBe(sourceHash);
		void sourceRoot;
	});

	it("run 端独立校验 cwd：越根拒绝 PI_PROJECT_NOT_ALLOWED 且源不动", async () => {
		const { deps, sourceRoot } = await makeRunEnv();
		const foreign = join(sourceRoot, "foreign_c.jsonl");
		const before = createHash("sha256").update(await readFile(foreign)).digest("hex");

		const { results } = await importNativeSessions(["foreign_c.jsonl"], deps);

		expect(results[0]).toMatchObject({
			status: "rejected",
			reasonCode: "PI_PROJECT_NOT_ALLOWED",
		});
		expect(createHash("sha256").update(await readFile(foreign)).digest("hex")).toBe(before);
	});

	it("副本校验失败 → 清理半成品并返回 PI_CONFIG_UNAVAILABLE", async () => {
		const { deps, projectDir } = await makeRunEnv();
		const failing: ImportRunDeps = {
			...deps,
			verifyTarget: () => {
				throw new Error("corrupt copy");
			},
		};

		const { results } = await importNativeSessions(["nested_a.jsonl"], failing);

		expect(results[0]).toMatchObject({
			status: "rejected",
			reasonCode: "PI_CONFIG_UNAVAILABLE",
		});
		expect(existsSync(await targetFor(deps, projectDir, "nested_a.jsonl"))).toBe(false);
	});

	it("批量部分失败逐条独立结果，不整体回滚", async () => {
		const { deps, projectDir } = await makeRunEnv();

		const { results } = await importNativeSessions(
			["nested_a.jsonl", "missing.jsonl", "flat_b.jsonl"],
			deps,
		);

		expect(results.map((item) => item.status)).toEqual([
			"imported",
			"rejected",
			"imported",
		]);
		expect(results[1]?.reasonCode).toBe("PI_SESSION_NOT_FOUND");
		expect(existsSync(await targetFor(deps, projectDir, "flat_b.jsonl"))).toBe(true);
	});
});

describe("importNativeSessions 的入参护栏", () => {
	it("非数组或含非字符串时抛 PI_PROTOCOL_INVALID（防止字符串按字符迭代）", async () => {
		const deps: ImportRunDeps = {
			sourceRoot: await mkdtemp(join(tmpdir(), "vcp-guard-")),
			roots: [],
			sessionsRoot: await mkdtemp(join(tmpdir(), "vcp-guard-sess-")),
			installSecretPath: join(
				await mkdtemp(join(tmpdir(), "vcp-guard-secret-")),
				"install-secret",
			),
		};
		await expect(
			importNativeSessions(undefined as never, deps),
		).rejects.toMatchObject({ code: "PI_PROTOCOL_INVALID" });
		await expect(
			importNativeSessions([123] as never, deps),
		).rejects.toMatchObject({ code: "PI_PROTOCOL_INVALID" });
	});
});
