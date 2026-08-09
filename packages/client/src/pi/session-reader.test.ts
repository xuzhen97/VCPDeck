import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSessionReader, PI_CONTEXT_PAGE_SIZE } from "./session-reader.js";

let roots: string[] = [];
let seq = 0;

async function makeDirs() {
	const base = await mkdtemp(join(tmpdir(), `pi-session-${++seq}-`));
	const cwd = join(base, "project");
	const sessionDir = join(base, "sessions");
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDir, { recursive: true });
	roots.push(base);
	return { cwd, sessionDir };
}

async function writeSession(
	sessionDir: string,
	cwd: string,
	id: string,
	entries: unknown[],
	parentSession?: string,
): Promise<string> {
	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const path = join(sessionDir, `${fileTimestamp}_${id}.jsonl`);
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id,
		timestamp,
		cwd,
	};
	if (parentSession) header.parentSession = parentSession;
	await writeFile(
		path,
		[JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n",
		"utf8",
	);
	return path;
}

const msg = (
	id: string,
	parentId: string | null,
	role: string,
	content: unknown[],
	toolCallId?: string,
) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date().toISOString(),
	message: { role, content, ...(toolCallId ? { toolCallId } : {}) },
});

const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t });

afterEach(async () => {
	await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
	roots = [];
});

describe("PiSessionReader", () => {
	it("只列当前 cwd 的 Session 且不暴露文件路径", async () => {
		const { cwd, sessionDir } = await makeDirs();
		const p1 = await writeSession(sessionDir, cwd, "s1", [msg("m1", null, "user", [text("hi")])]);
		await writeSession(sessionDir, cwd, "s2", [msg("m1", null, "user", [text("yo")])], p1);

		const reader = createPiSessionReader(cwd, sessionDir);
		const sessions = await reader.list();

		expect(sessions).toHaveLength(2);
		expect(sessions[0]).not.toHaveProperty("path");
		expect(JSON.stringify(sessions)).not.toContain(sessionDir);
		const child = sessions.find((s) => s.id === "s2");
		expect(child?.parentSessionId).toBe("s1");
	});

	it("按最新窗口分页返回历史", async () => {
		const { cwd, sessionDir } = await makeDirs();
		const entries: unknown[] = [];
		let parent: string | null = null;
		for (let i = 0; i < PI_CONTEXT_PAGE_SIZE + 20; i++) {
			const id = `m${i}`;
			entries.push(msg(id, parent, "user", [text(`msg ${i}`)]));
			parent = id;
		}
		await writeSession(sessionDir, cwd, "s1", entries);

		const reader = createPiSessionReader(cwd, sessionDir);
		const page1 = await reader.context("s1");
		expect(page1.messages).toHaveLength(PI_CONTEXT_PAGE_SIZE);
		expect(page1.nextCursor).not.toBeNull();
		expect(page1.messages.at(-1)?.id).toBe(`m${PI_CONTEXT_PAGE_SIZE + 19}`);

		const page2 = await reader.context("s1", undefined, page1.nextCursor);
		expect(page2.messages).toHaveLength(20);
		expect(page2.messages[0]?.id).toBe("m0");
		expect(page2.nextCursor).toBeNull();
	});

	it("thinking 正文不进入历史响应", async () => {
		const { cwd, sessionDir } = await makeDirs();
		await writeSession(sessionDir, cwd, "s1", [
			msg("m1", null, "user", [text("hi")]),
			msg("m2", "m1", "assistant", [thinking("secret thinking"), text("answer")]),
		]);

		const reader = createPiSessionReader(cwd, sessionDir);
		const page = await reader.context("s1");
		expect(JSON.stringify(page)).not.toContain("secret thinking");
		const assistant = page.messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
	});

	it("超大 Tool Result 延迟加载", async () => {
		const { cwd, sessionDir } = await makeDirs();
		const huge = "x".repeat(300 * 1024);
		await writeSession(sessionDir, cwd, "s1", [
			msg("m1", null, "user", [text("hi")]),
			msg("m2", "m1", "toolResult", [text(huge)], "t1"),
		]);

		const reader = createPiSessionReader(cwd, sessionDir);
		const page = await reader.context("s1");
		expect(JSON.stringify(page)).not.toContain(huge);
		expect(JSON.stringify(page)).toContain("Tool result truncated");
	});

	it("只读 state 投影最近模型与思考深度且固定 idle", async () => {
		const { cwd, sessionDir } = await makeDirs();
		await writeSession(sessionDir, cwd, "s1", [
			{ type: "model_change", id: "model-1", parentId: null, timestamp: new Date().toISOString(), provider: "AxonHub", modelId: "gpt-5.5" },
			{ type: "thinking_level_change", id: "thinking-1", parentId: "model-1", timestamp: new Date().toISOString(), thinkingLevel: "max" },
		]);

		await expect(createPiSessionReader(cwd, sessionDir).state("s1")).resolves.toEqual({
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			thinkingLevel: "max",
			queuedMessages: { steering: [], followUp: [] },
			model: { provider: "AxonHub", modelId: "gpt-5.5" },
		});
	});

	it("只读 state 在无 thinking 记录时使用 off", async () => {
		const { cwd, sessionDir } = await makeDirs();
		await writeSession(sessionDir, cwd, "s1", []);
		expect((await createPiSessionReader(cwd, sessionDir).state("s1")).thinkingLevel).toBe("off");
	});

	it("重命名 Session", async () => {
		const { cwd, sessionDir } = await makeDirs();
		await writeSession(sessionDir, cwd, "s1", [msg("m1", null, "user", [text("hi")])]);

		const reader = createPiSessionReader(cwd, sessionDir);
		await reader.rename("s1", "  我的会话  ");
		const detail = await reader.get("s1");
		expect(detail.info.name).toBe("我的会话");
	});

	it("拒绝空名称重命名", async () => {
		const { cwd, sessionDir } = await makeDirs();
		await writeSession(sessionDir, cwd, "s1", [msg("m1", null, "user", [text("hi")])]);
		const reader = createPiSessionReader(cwd, sessionDir);
		await expect(reader.rename("s1", "   ")).rejects.toMatchObject({
			code: "PI_PROTOCOL_INVALID",
		});
	});

	it("删除时把直接子 Session 重新挂到祖父", async () => {
		const { cwd, sessionDir } = await makeDirs();
		const pA = await writeSession(sessionDir, cwd, "a", [msg("m1", null, "user", [text("a")])]);
		const pB = await writeSession(sessionDir, cwd, "b", [msg("m1", null, "user", [text("b")])], pA);
		await writeSession(sessionDir, cwd, "c", [msg("m1", null, "user", [text("c")])], pB);

		const reader = createPiSessionReader(cwd, sessionDir);
		await reader.delete("b");

		const sessions = await reader.list();
		expect(sessions.find((s) => s.id === "b")).toBeUndefined();
		expect(sessions.find((s) => s.id === "c")?.parentSessionId).toBe("a");

		// 文件层面验证 header 被原子改写
		const files = await readdirFiles(sessionDir);
		for (const f of files) {
			if (!f.includes("_c.jsonl")) continue;
			const content = await readFile(join(sessionDir, f), "utf8");
			let header: { parentSession?: string } | null = null;
			try {
				header = JSON.parse(content.split("\n")[0]) as { parentSession?: string };
			} catch {
				// 解析失败视为断言失败
			}
			expect(header?.parentSession).toContain("_a.jsonl");
		}
	});

	it("fork 到指定消息之前并设置 parentSession", async () => {
		const { cwd, sessionDir } = await makeDirs();
		await writeSession(sessionDir, cwd, "s1", [
			msg("m1", null, "user", [text("first")]),
			msg("m2", "m1", "assistant", [text("second")]),
			msg("m3", "m2", "user", [text("third")]),
			msg("m4", "m3", "assistant", [text("fourth")]),
		]);

		const reader = createPiSessionReader(cwd, sessionDir);
		const { sessionId: newId } = await reader.fork("s1", "m2");

		const page = await reader.context(newId);
		expect(page.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		const detail = await reader.get(newId);
		expect(detail.info.parentSessionId).toBe("s1");
	});

	it("clone 复制当前活动分支", async () => {
		const { cwd, sessionDir } = await makeDirs();
		await writeSession(sessionDir, cwd, "s1", [
			msg("m1", null, "user", [text("first")]),
			msg("m2", "m1", "assistant", [text("second")]),
		]);

		const reader = createPiSessionReader(cwd, sessionDir);
		const { sessionId: newId } = await reader.clone("s1");
		const page = await reader.context(newId);
		expect(page.messages).toHaveLength(2);
	});

	it("拒绝跨 cwd 访问 Session", async () => {
		const { cwd, sessionDir } = await makeDirs();
		await writeSession(sessionDir, cwd, "s1", [msg("m1", null, "user", [text("hi")])]);
		const other = await mkdtemp(join(tmpdir(), `pi-session-other-${++seq}-`));
		roots.push(other);

		const reader = createPiSessionReader(other, sessionDir);
		await expect(reader.context("s1")).rejects.toMatchObject({
			code: "PI_SESSION_NOT_FOUND",
		});
	});
});

async function readdirFiles(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	return readdir(dir);
}
