import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** 真实 SDK Session + 本地模型响应：不调用外网、不接触用户 Pi 数据目录。 */
it("真实 Pi SDK 把空文本图片作为 user message 写入并从 JSONL 恢复", async () => {
	const root = mkdtempSync(join(tmpdir(), "vcpdeck-pi-image-only-"));
	roots.push(root);
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager });
	await resourceLoader.reload();
	const manager = SessionManager.create(root, join(root, "sessions"));
	const model = {
		id: "test-model", name: "test-model", provider: "test", api: "openai-completions",
		baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
	};
	let seen: unknown;
	const modelRuntime = {
		hasConfiguredAuth: () => true,
		checkAuth: async () => "test-key",
		getAuth: async () => "test-key",
		streamSimple: (_model: unknown, context: unknown) => {
			seen = context;
			const response = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "test", model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
			return {
				async *[Symbol.asyncIterator]() { yield { type: "done", message: response }; },
				result: async () => response,
			};
		},
	};
	let session: AgentSession | undefined;
	try {
		const created = await createAgentSession({ cwd: root, agentDir: root, model: model as never, modelRuntime: modelRuntime as never, sessionManager: manager, settingsManager, resourceLoader, tools: [] });
		session = created.session;
		await session.prompt("", { images: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==" }] });
		const user = (seen as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }).messages.find((m) => m.role === "user");
		expect(user?.content.map((item) => item.type)).toEqual(["text", "image"]);
		expect(user?.content[0]?.text).toBe("");
		const file = manager.getSessionFile();
		expect(file).toBeTruthy();
		const entries = readFileSync(file!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(entries.some((entry) => entry.type === "message" && entry.message?.role === "user" && entry.message.content[0].text === "" && entry.message.content[1].type === "image")).toBe(true);
		const reopened = SessionManager.open(file!, join(root, "sessions"));
		expect(reopened.buildSessionContext().messages.some((message) => {
			if (message.role !== "user" || !Array.isArray(message.content)) return false;
			const [text, image] = message.content;
			return typeof text !== "string" && text?.type === "text" && text.text === "" && typeof image !== "string" && image?.type === "image";
		})).toBe(true);
	} finally { session?.dispose(); }
});
