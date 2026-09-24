import { afterEach, describe, expect, it } from "vitest";
import toolPolicyExtension from "./index.js";

type Decision = { block?: boolean; reason?: string } | undefined;

interface FakePi {
	handlers: Array<
		(event: { toolName: string }, ctx: unknown) => Promise<Decision>
	>;
	on: (
		event: string,
		handler: (event: { toolName: string }, ctx: unknown) => Promise<Decision>,
	) => void;
}

function fakePi(): FakePi {
	const handlers: FakePi["handlers"] = [];
	return { handlers, on: (_event, handler) => handlers.push(handler) };
}

function installBridge(policy: {
	allow: string[];
	confirm: string[];
	deny: string[];
}, bridgeVersion = 1): void {
	(globalThis as { __vcpdeckPiHost?: unknown }).__vcpdeckPiHost = {
		bridgeVersion,
		toolPolicy: policy,
	};
}

function run(
	pi: FakePi,
	toolName: string,
	approved = false,
): Promise<Decision> {
	const handler = pi.handlers[0];
	if (!handler) throw new Error("extension did not register a tool_call handler");
	return handler({ toolName }, { ui: { confirm: async () => approved } });
}

afterEach(() => {
	delete (globalThis as { __vcpdeckPiHost?: unknown }).__vcpdeckPiHost;
});

describe("vcp.tool-policy 扩展", () => {
	it("deny 桶直接阻塞（PI_TOOL_POLICY_DENIED）", async () => {
		installBridge({ allow: [], confirm: [], deny: ["bash"] });
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await run(pi, "bash")).toEqual({
			block: true,
			reason: "PI_TOOL_POLICY_DENIED: bash",
		});
	});

	it("confirm 桶在批准前阻塞，批准后放行", async () => {
		installBridge({ allow: [], confirm: ["bash"], deny: [] });
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await run(pi, "bash", false)).toEqual({
			block: true,
			reason: "PI_TOOL_POLICY_REJECTED: bash",
		});
		expect(await run(pi, "bash", true)).toBeUndefined();
	});

	it("allow 桶不阻塞", async () => {
		installBridge({ allow: ["read"], confirm: [], deny: [] });
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await run(pi, "read")).toBeUndefined();
	});

	it("未出现在任何桶的工具被阻塞（默认拒绝）", async () => {
		installBridge({ allow: ["read"], confirm: [], deny: [] });
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await run(pi, "write")).toEqual({
			block: true,
			reason: "PI_TOOL_POLICY_DENIED: write",
		});
	});

	it("桥接缺失时全部阻塞（PI_POLICY_UNAVAILABLE，不 fail open）", async () => {
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await run(pi, "read")).toEqual({
			block: true,
			reason: "PI_POLICY_UNAVAILABLE: read",
		});
	});

	it("桥接版本不符时全部阻塞", async () => {
		installBridge({ allow: ["read"], confirm: [], deny: [] }, 2);
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await run(pi, "read")).toEqual({
			block: true,
			reason: "PI_POLICY_UNAVAILABLE: read",
		});
	});

	it("桥接策略形状非法时按不可用处理（不放行）", async () => {
		(globalThis as { __vcpdeckPiHost?: unknown }).__vcpdeckPiHost = {
			bridgeVersion: 1,
		};
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await run(pi, "read")).toEqual({
			block: true,
			reason: "PI_POLICY_UNAVAILABLE: read",
		});
	});
});
