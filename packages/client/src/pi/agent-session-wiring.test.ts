/**
 * `startPiAgentSession` 的接线测试：策略与 Bundle 资源必须真的到达 SDK 调用点。
 *
 * 为什么单独成文件：本文件 mock 了 Pi SDK 模块，而 `agent-session.test.ts` 直接构造
 * wrapper 并使用真实模块类型；把 mock 放进去会影响该文件其余用例。
 *
 * 覆盖的安全属性（docs/adr/0030 决策 2/3）：
 * - `tools` = allow ∪ confirm，`excludeTools` = deny（未列出工具不可用由白名单语义保证）；
 * - 只把已校验 Bundle 的扩展入口放进 `resourceLoaderOptions.additionalExtensionPaths`，
 *   并关闭发现面（`noExtensions` 等）；
 * - 会话创建前已安装进程内策略桥接（扩展在 factory 阶段读它）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PI_TOOL_POLICY_BRIDGE_KEY, readToolPolicyBridge } from "./tool-policy-bridge.js";

const captured = {
	services: [] as Array<Record<string, unknown>>,
	session: [] as Array<Record<string, unknown>>,
};

function makeFakeInner() {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		sessionId: "s1",
		sessionFile: "/tmp/sessions/s1.jsonl",
		isStreaming: false,
		isCompacting: false,
		thinkingLevel: "off",
		model: { provider: "anthropic", id: "claude-x" },
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		extensionRunner: { setUIContext: vi.fn() },
		dispose: vi.fn(),
		sessionManager: { getCwd: () => "/tmp/project", getSessionDir: () => "/tmp/sessions" },
	};
}

vi.mock("@earendil-works/pi-coding-agent", () => {
	const fakeInner = makeFakeInner();
	return {
		SettingsManager: { inMemory: () => ({}) },
		SessionManager: {
			create: () => ({ getCwd: () => "/tmp/project", getBranch: () => [] }),
			open: () => ({ getCwd: () => "/tmp/project", getBranch: () => [] }),
		},
		createAgentSessionServices: async (options: Record<string, unknown>) => {
			captured.services.push(options);
			// 真实 SDK 会无条件调用 modelRuntime.refresh（agent-session-services.js:98）
			const mr = options.modelRuntime as { refresh?: unknown } | undefined;
			if (!mr || typeof mr.refresh !== "function") {
				throw new TypeError("modelRuntime.refresh is not a function");
			}
			return { modelRuntime: { getModel: () => ({ provider: "anthropic", id: "claude-x" }) } };
		},
		createAgentSessionFromServices: async (options: Record<string, unknown>) => {
			captured.session.push(options);
			return { session: fakeInner as unknown as AgentSession };
		},
	};
});

import { startPiAgentSession } from "./agent-session.js";

const policy = {
	allow: ["read", "grep"],
	confirm: ["bash"],
	deny: ["write"],
};

beforeEach(() => {
	captured.services.length = 0;
	captured.session.length = 0;
	delete (globalThis as Record<string, unknown>)[PI_TOOL_POLICY_BRIDGE_KEY];
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>)[PI_TOOL_POLICY_BRIDGE_KEY];
});

describe("startPiAgentSession 的策略与 Bundle 接线", () => {
	it("下发 tools = allow ∪ confirm，excludeTools = deny", async () => {
		const wrapper = await startPiAgentSession({
			cwd: "/tmp/project",
			sessionDir: "/tmp/sessions",
			agentDir: "/tmp/agent",
			modelRuntime: { refresh: vi.fn() },
			modelScope: [{ provider: "anthropic", modelId: "claude-x" }],
			toolPolicy: policy,
		});

		expect(captured.session[0]).toMatchObject({
			tools: ["bash", "grep", "read"],
			excludeTools: ["write"],
		});
		wrapper.destroy();
	});

	it("只把已校验 Bundle 扩展入口放进加载面，并关闭资源发现", async () => {
		const wrapper = await startPiAgentSession({
			cwd: "/tmp/project",
			sessionDir: "/tmp/sessions",
			agentDir: "/tmp/agent",
			modelRuntime: { refresh: vi.fn() },
			modelScope: [{ provider: "anthropic", modelId: "claude-x" }],
			toolPolicy: policy,
			bundleExtensionPaths: ["/app/apps/0.11.0/pi-resources/extensions/vcp-tool-policy/index.js"],
		});

		expect(captured.services[0]?.resourceLoaderOptions).toMatchObject({
			additionalExtensionPaths: [
				"/app/apps/0.11.0/pi-resources/extensions/vcp-tool-policy/index.js",
			],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		expect(captured.services[0]?.resourceLoaderReloadOptions).toBeDefined();
		wrapper.destroy();
	});

	it("没有 Bundle 扩展时不传 additionalExtensionPaths（等价不加载任何扩展）", async () => {
		const wrapper = await startPiAgentSession({
			cwd: "/tmp/project",
			sessionDir: "/tmp/sessions",
			agentDir: "/tmp/agent",
			modelRuntime: { refresh: vi.fn() },
			modelScope: [{ provider: "anthropic", modelId: "claude-x" }],
			toolPolicy: policy,
		});

		const options = captured.services[0]?.resourceLoaderOptions as
			| { additionalExtensionPaths?: string[] }
			| undefined;
		expect(options?.additionalExtensionPaths).toBeUndefined();
		wrapper.destroy();
	});

	it("会话创建前已安装进程内策略桥接（不落盘、不进环境变量）", async () => {
		const wrapper = await startPiAgentSession({
			cwd: "/tmp/project",
			sessionDir: "/tmp/sessions",
			agentDir: "/tmp/agent",
			modelRuntime: { refresh: vi.fn() },
			modelScope: [{ provider: "anthropic", modelId: "claude-x" }],
			toolPolicy: policy,
		});

		expect(readToolPolicyBridge()).toEqual({ bridgeVersion: 1, toolPolicy: policy });
		// 策略不得出现在环境变量里（bash 子进程会继承）
		expect(JSON.stringify(process.env)).not.toContain("vcpdeckPiHost");
		wrapper.destroy();
	});
});
