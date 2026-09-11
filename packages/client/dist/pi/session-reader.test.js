"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const session_reader_js_1 = require("./session-reader.js");
let roots = [];
let seq = 0;
async function makeDirs() {
    const base = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-session-${++seq}-`));
    const cwd = (0, node_path_1.join)(base, "project");
    const sessionDir = (0, node_path_1.join)(base, "sessions");
    await (0, promises_1.mkdir)(cwd, { recursive: true });
    await (0, promises_1.mkdir)(sessionDir, { recursive: true });
    roots.push(base);
    return { cwd, sessionDir };
}
async function writeSession(sessionDir, cwd, id, entries, parentSession) {
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const path = (0, node_path_1.join)(sessionDir, `${fileTimestamp}_${id}.jsonl`);
    const header = {
        type: "session",
        version: 3,
        id,
        timestamp,
        cwd,
    };
    if (parentSession)
        header.parentSession = parentSession;
    await (0, promises_1.writeFile)(path, [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n", "utf8");
    return path;
}
const msg = (id, parentId, role, content, toolCallId) => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role, content, ...(toolCallId ? { toolCallId } : {}) },
});
const text = (t) => ({ type: "text", text: t });
const thinking = (t) => ({ type: "thinking", thinking: t });
(0, vitest_1.afterEach)(async () => {
    await Promise.all(roots.map((r) => (0, promises_1.rm)(r, { recursive: true, force: true })));
    roots = [];
});
(0, vitest_1.describe)("PiSessionReader", () => {
    (0, vitest_1.it)("只列当前 cwd 的 Session 且不暴露文件路径", async () => {
        const { cwd, sessionDir } = await makeDirs();
        const p1 = await writeSession(sessionDir, cwd, "s1", [msg("m1", null, "user", [text("hi")])]);
        await writeSession(sessionDir, cwd, "s2", [msg("m1", null, "user", [text("yo")])], p1);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        const sessions = await reader.list();
        (0, vitest_1.expect)(sessions).toHaveLength(2);
        (0, vitest_1.expect)(sessions[0]).not.toHaveProperty("path");
        (0, vitest_1.expect)(JSON.stringify(sessions)).not.toContain(sessionDir);
        const child = sessions.find((s) => s.id === "s2");
        (0, vitest_1.expect)(child?.parentSessionId).toBe("s1");
    });
    (0, vitest_1.it)("按最新窗口分页返回历史", async () => {
        const { cwd, sessionDir } = await makeDirs();
        const entries = [];
        let parent = null;
        for (let i = 0; i < session_reader_js_1.PI_CONTEXT_PAGE_SIZE + 20; i++) {
            const id = `m${i}`;
            entries.push(msg(id, parent, "user", [text(`msg ${i}`)]));
            parent = id;
        }
        await writeSession(sessionDir, cwd, "s1", entries);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        const page1 = await reader.context("s1");
        (0, vitest_1.expect)(page1.messages).toHaveLength(session_reader_js_1.PI_CONTEXT_PAGE_SIZE);
        (0, vitest_1.expect)(page1.nextCursor).not.toBeNull();
        (0, vitest_1.expect)(page1.messages.at(-1)?.id).toBe(`m${session_reader_js_1.PI_CONTEXT_PAGE_SIZE + 19}`);
        const page2 = await reader.context("s1", undefined, page1.nextCursor);
        (0, vitest_1.expect)(page2.messages).toHaveLength(20);
        (0, vitest_1.expect)(page2.messages[0]?.id).toBe("m0");
        (0, vitest_1.expect)(page2.nextCursor).toBeNull();
    });
    (0, vitest_1.it)("thinking 正文不进入历史响应", async () => {
        const { cwd, sessionDir } = await makeDirs();
        await writeSession(sessionDir, cwd, "s1", [
            msg("m1", null, "user", [text("hi")]),
            msg("m2", "m1", "assistant", [thinking("secret thinking"), text("answer")]),
        ]);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        const page = await reader.context("s1");
        (0, vitest_1.expect)(JSON.stringify(page)).not.toContain("secret thinking");
        const assistant = page.messages.find((m) => m.role === "assistant");
        (0, vitest_1.expect)(assistant).toBeDefined();
    });
    (0, vitest_1.it)("超大 Tool Result 延迟加载", async () => {
        const { cwd, sessionDir } = await makeDirs();
        const huge = "x".repeat(300 * 1024);
        await writeSession(sessionDir, cwd, "s1", [
            msg("m1", null, "user", [text("hi")]),
            msg("m2", "m1", "toolResult", [text(huge)], "t1"),
        ]);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        const page = await reader.context("s1");
        (0, vitest_1.expect)(JSON.stringify(page)).not.toContain(huge);
        (0, vitest_1.expect)(JSON.stringify(page)).toContain("Tool result truncated");
    });
    (0, vitest_1.it)("只读 state 投影最近模型与思考深度且固定 idle", async () => {
        const { cwd, sessionDir } = await makeDirs();
        await writeSession(sessionDir, cwd, "s1", [
            { type: "model_change", id: "model-1", parentId: null, timestamp: new Date().toISOString(), provider: "AxonHub", modelId: "gpt-5.5" },
            { type: "thinking_level_change", id: "thinking-1", parentId: "model-1", timestamp: new Date().toISOString(), thinkingLevel: "max" },
        ]);
        await (0, vitest_1.expect)((0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir).state("s1")).resolves.toEqual({
            status: "idle",
            streaming: false,
            prompting: false,
            compacting: false,
            thinkingLevel: "max",
            queuedMessages: { steering: [], followUp: [] },
            model: { provider: "AxonHub", modelId: "gpt-5.5" },
        });
    });
    (0, vitest_1.it)("只读 state 在无 thinking 记录时使用 off", async () => {
        const { cwd, sessionDir } = await makeDirs();
        await writeSession(sessionDir, cwd, "s1", []);
        (0, vitest_1.expect)((await (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir).state("s1")).thinkingLevel).toBe("off");
    });
    (0, vitest_1.it)("重命名 Session", async () => {
        const { cwd, sessionDir } = await makeDirs();
        await writeSession(sessionDir, cwd, "s1", [msg("m1", null, "user", [text("hi")])]);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        await reader.rename("s1", "  我的会话  ");
        const detail = await reader.get("s1");
        (0, vitest_1.expect)(detail.info.name).toBe("我的会话");
    });
    (0, vitest_1.it)("拒绝空名称重命名", async () => {
        const { cwd, sessionDir } = await makeDirs();
        await writeSession(sessionDir, cwd, "s1", [msg("m1", null, "user", [text("hi")])]);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        await (0, vitest_1.expect)(reader.rename("s1", "   ")).rejects.toMatchObject({
            code: "PI_PROTOCOL_INVALID",
        });
    });
    (0, vitest_1.it)("删除时把直接子 Session 重新挂到祖父", async () => {
        const { cwd, sessionDir } = await makeDirs();
        const pA = await writeSession(sessionDir, cwd, "a", [msg("m1", null, "user", [text("a")])]);
        const pB = await writeSession(sessionDir, cwd, "b", [msg("m1", null, "user", [text("b")])], pA);
        await writeSession(sessionDir, cwd, "c", [msg("m1", null, "user", [text("c")])], pB);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        await reader.delete("b");
        const sessions = await reader.list();
        (0, vitest_1.expect)(sessions.find((s) => s.id === "b")).toBeUndefined();
        (0, vitest_1.expect)(sessions.find((s) => s.id === "c")?.parentSessionId).toBe("a");
        // 文件层面验证 header 被原子改写
        const files = await readdirFiles(sessionDir);
        for (const f of files) {
            if (!f.includes("_c.jsonl"))
                continue;
            const content = await (0, promises_1.readFile)((0, node_path_1.join)(sessionDir, f), "utf8");
            let header = null;
            try {
                header = JSON.parse(content.split("\n")[0]);
            }
            catch {
                // 解析失败视为断言失败
            }
            (0, vitest_1.expect)(header?.parentSession).toContain("_a.jsonl");
        }
    });
    (0, vitest_1.it)("fork 到指定消息之前并设置 parentSession", async () => {
        const { cwd, sessionDir } = await makeDirs();
        await writeSession(sessionDir, cwd, "s1", [
            msg("m1", null, "user", [text("first")]),
            msg("m2", "m1", "assistant", [text("second")]),
            msg("m3", "m2", "user", [text("third")]),
            msg("m4", "m3", "assistant", [text("fourth")]),
        ]);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        const { sessionId: newId } = await reader.fork("s1", "m2");
        const page = await reader.context(newId);
        (0, vitest_1.expect)(page.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
        const detail = await reader.get(newId);
        (0, vitest_1.expect)(detail.info.parentSessionId).toBe("s1");
    });
    (0, vitest_1.it)("clone 复制当前活动分支", async () => {
        const { cwd, sessionDir } = await makeDirs();
        await writeSession(sessionDir, cwd, "s1", [
            msg("m1", null, "user", [text("first")]),
            msg("m2", "m1", "assistant", [text("second")]),
        ]);
        const reader = (0, session_reader_js_1.createPiSessionReader)(cwd, sessionDir);
        const { sessionId: newId } = await reader.clone("s1");
        const page = await reader.context(newId);
        (0, vitest_1.expect)(page.messages).toHaveLength(2);
    });
    (0, vitest_1.it)("拒绝跨 cwd 访问 Session", async () => {
        const { cwd, sessionDir } = await makeDirs();
        await writeSession(sessionDir, cwd, "s1", [msg("m1", null, "user", [text("hi")])]);
        const other = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-session-other-${++seq}-`));
        roots.push(other);
        const reader = (0, session_reader_js_1.createPiSessionReader)(other, sessionDir);
        await (0, vitest_1.expect)(reader.context("s1")).rejects.toMatchObject({
            code: "PI_SESSION_NOT_FOUND",
        });
    });
});
async function readdirFiles(dir) {
    const { readdir } = await import("node:fs/promises");
    return readdir(dir);
}
