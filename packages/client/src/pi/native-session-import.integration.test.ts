/**
 * T1（事实锁定）：导入链路依赖的三条 SDK 行为。
 *
 * Plan 2.1 的发现与复制都建立在这些事实上，猜错会静默解析失败或漏列嵌套会话：
 * 1. 可解析 JSONL 的最小行形态（header 行 + entry 行）；
 * 2. entry 时间 = `SessionEntryBase.timestamp`，user 文本 = `SessionMessageEntry.message`；
 * 3. `open(绝对路径, sessionDir)` 对**深层子目录**路径的行为；`list` 是否递归。
 *
 * 红/绿语义：fixture 字段与 SDK 实际形态不符即红 → 按报错校准 fixture 为真实形态（绿）。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
let sdk: PiSdk;
beforeAll(async () => {
	sdk = await import("@earendil-works/pi-coding-agent");
});

/** 平台无关的 cwd 规范化：反斜杠 → 正斜杠，剥 Windows 盘符（SDK 会在当前盘解析存储的 cwd）。 */
function normalizeCwd(value: string): string {
	return value.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
}

/** 按 session-manager.d.ts 类型构造可解析的会话文件。 */
async function writeNativeSession(
	root: string,
	projectDir: string,
	relDir: string,
	name: string,
): Promise<string> {
	const dir = join(root, relDir);
	await mkdir(dir, { recursive: true });
	const lines = [
		{
			type: "session",
			version: 1,
			id: "s-native-1",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: projectDir,
		},
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-09-01T00:00:01.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "第一个问题 hello world" }],
			},
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-09-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "回答" }],
			},
		},
	];
	const file = join(dir, name);
	await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
	return file;
}

describe("SDK 会话读取行为（导入依赖的事实）", () => {
	it("open 能读取嵌套路径的 JSONL：branch/时间/正文字段可用", async () => {
		const root = await mkdtemp(join(tmpdir(), "vcp-native-"));
		const file = await writeNativeSession(
			root,
			"/proj/a",
			"--d--proj-a--",
			"2026-09-01T000000_s-native-1.jsonl",
		);

		const manager = sdk.SessionManager.open(file, root);

		expect(manager.getSessionId()).toBeTruthy();
		// 事实：getCwd() 对存储 cwd 做平台化解析（Windows 上 `/x/y` → 当前盘符 + 反斜杠）
		expect(normalizeCwd(manager.getCwd())).toBe("/proj/a");
		const branch = manager.getBranch();
		expect(branch).toHaveLength(2);
		expect(branch[0]?.timestamp).toBe("2026-09-01T00:00:01.000Z");
		const message = (branch[0] as { message?: { role?: string } }).message;
		expect(message?.role).toBe("user");
	});

	it("list 的递归行为被明确锁定（递归或不递归皆记录）", async () => {
		const root = await mkdtemp(join(tmpdir(), "vcp-native-"));
		await writeNativeSession(root, "/proj/a", "--d--proj-a--", "2026-09-01_a.jsonl");

		const sessions = await sdk.SessionManager.list("/proj/a", root);
		expect(Array.isArray(sessions)).toBe(true);
		const recurses = sessions.some((entry) => String(entry.path).includes("--d--proj-a--"));
		// 事实记录：list 是否递归（决定 T3 是否自行递归收集）
		console.log("[fact] SessionManager.list recurses:", recurses, "| found:", sessions.length);
		if (recurses) {
			expect(sessions).toHaveLength(1);
		} else {
			expect(sessions).toHaveLength(0);
		}
	});

	it("SessionManager.open 会就地改写文件（⇒ 导入链路禁用它读源）", async () => {
		const root = await mkdtemp(join(tmpdir(), "vcp-mutate-"));
		const file = await writeNativeSession(root, "/proj/a", "flat", "m.jsonl");
		const before = createHash("sha256").update(await readFile(file)).digest("hex");

		const manager = sdk.SessionManager.open(file, root);
		manager.getBranch();

		const after = createHash("sha256").update(await readFile(file)).digest("hex");
		// 事实锁定：open 会触发 version 迁移与 entry id 重写 → 即使“只读意图”也改用户数据。
		// ADR-0031 禁止用它读源；导入链路必须纯 fs 自解析。
		expect(after).not.toBe(before);
	});

	it("损坏 JSONL 只读打开时失败（供 unreadable 判定复用）", async () => {
		const root = await mkdtemp(join(tmpdir(), "vcp-native-"));
		const file = join(root, "broken.jsonl");
		await writeFile(file, "{ not json\n", "utf8");

		let threw = false;
		try {
			sdk.SessionManager.open(file, root);
			// open 可能延迟解析：branch 访问时才失败
			const manager = sdk.SessionManager.open(file, root);
			manager.getBranch();
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});
