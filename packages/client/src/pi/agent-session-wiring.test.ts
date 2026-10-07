/**
 * `startPiAgentSession` 的接线测试：执行模式与 Bundle 资源必须真的到达 SDK 调用点。
 *
 * 为什么单独成文件：本文件 mock 了 Pi SDK 模块，而 `agent-session.test.ts` 直接构造
 * wrapper 并使用真实模块类型；把 mock 放进去会影响该文件其余用例。
 *
 * 覆盖的安全属性（ADR-0039 决策 1、ADR-0040 决策 1）：
 * - **不传 `tools` 全工具 allowlist**：SDK 的 `tools` 是 allowlist，只列内置工具会把扩展
 *   注册的工具整体过滤掉（已由 `extension-host.integration.test.ts` 用真实 SDK 锁定）；
 * - 会话构建后按**运行时实际注册集合**激活工具（内置 + 扩展），仅剔除平台不存在的 shell；
 * - 只把已校验 Bundle 的扩展入口放进 `resourceLoaderOptions.additionalExtensionPaths`，
 *   并关闭发现面（`noExtensions` 等）；
 * - 会话创建前已安装进程内执行模式桥接 v3（扩展在 factory 阶段读它）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PI_TOOL_POLICY_BRIDGE_KEY, readToolPolicyBridge } from "./tool-policy-bridge.js";

const captured = {
	services: [] as Array<Record<string, unknown>>,
	session: [] as Array<Record<string, unknown>>,
	activeTools: [] as string[][],
};

/** 运行时实际注册的工具集合：内置 + 一个受信扩展注册的工具。 */
const REGISTERED_TOOLS = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"fixture_echo",
];

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
		getAllTools: () => REGISTERED_TOOLS.map((name) => ({ name })),
		setActiveToolsByName: (names: string[]) => {
			captured.activeTools.push(names);
		},
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

function baseOptions(extra: Record<string, unknown> = {}) {
	return {
		cwd: "/tmp/project",
		sessionDir: "/tmp/sessions",
		agentDir: "/tmp/agent",
		modelRuntime: { refresh: vi.fn() },
		modelScope: [{ provider: "anthropic", modelId: "claude-x" }],
		toolExecutionMode: "supervised" as const,
		...extra,
	};
}

beforeEach(() => {
	captured.services.length = 0;
	captured.session.length = 0;
	captured.activeTools.length = 0;
	delete (globalThis as Record<string, unknown>)[PI_TOOL_POLICY_BRIDGE_KEY];
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>)[PI_TOOL_POLICY_BRIDGE_KEY];
});

describe("startPiAgentSession 的执行模式与 Bundle 接线", () => {
	it("不给 SDK 传内置-only 白名单（否则扩展工具会被整体过滤）", async () => {
		const wrapper = await startPiAgentSession(baseOptions());

		expect(captured.session[0]).not.toHaveProperty("tools");
		expect(captured.session[0]).not.toHaveProperty("excludeTools");
		wrapper.destroy();
	});

	it("会话构建后按实际注册集合激活工具，并保留扩展注册的工具", async () => {
		const wrapper = await startPiAgentSession(baseOptions());

		const active = captured.activeTools[0];
		expect(active).toContain("read");
		expect(active).toContain("grep");
		// 扩展注册的工具必须进入激活集合（旧实现会被内置白名单挡掉）。
		expect(active).toContain("fixture_echo");
		// 平台不存在的 shell 被剔除（非 Windows 无 powershell；无 Git Bash 则无 bash）。
		if (process.platform !== "win32") expect(active).not.toContain("powershell");
		wrapper.destroy();
	});

	it("只把已校验 Bundle 扩展入口放进加载面，并关闭资源发现", async () => {
		const wrapper = await startPiAgentSession(
			baseOptions({
				bundleExtensionPaths: [
					"/app/apps/0.11.0/pi-resources/extensions/vcp-tool-policy/index.js",
				],
			}),
		);

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
		const wrapper = await startPiAgentSession(baseOptions());

		const options = captured.services[0]?.resourceLoaderOptions as
			| { additionalExtensionPaths?: string[] }
			| undefined;
		expect(options?.additionalExtensionPaths).toBeUndefined();
		wrapper.destroy();
	});

	it("会话创建前已安装进程内模式桥接 v3（不落盘、不进环境变量）", async () => {
		const wrapper = await startPiAgentSession(
			baseOptions({ toolExecutionMode: "automatic" }),
		);

		expect(readToolPolicyBridge()).toEqual({
			bridgeVersion: 3,
			toolExecutionMode: "automatic",
		});
		// 模式不得出现在环境变量里（bash 子进程会继承）
		expect(JSON.stringify(process.env)).not.toContain("vcpdeckPiHost");
		wrapper.destroy();
	});
});
