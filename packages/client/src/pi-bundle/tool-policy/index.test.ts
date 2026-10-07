/**
 * vcp.tool-policy 扩展 v3（ADR-0039 两模式）。
 *
 * 语义收敛为两条：
 * - `automatic`：直接放行（能力面由当前 Runtime 实际注册/加载的工具决定）；
 * - `supervised`：**每次**模型工具调用都要求人工批准（含读取工具），
 *   拒绝/取消/超时一律阻塞。
 *
 * 桥接缺失、版本不符或模式非法时**阻塞所有工具调用**（fail closed）。
 * 逐工具三桶已删除：扩展不再读取任何 allow/confirm/deny 列表。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import toolPolicyExtension from "./index.js";

type Decision = { block?: boolean; reason?: string } | undefined;
type Mode = "supervised" | "automatic";

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

/** 安装 bridge v3：只携带模式（不再有 toolPolicy）。 */
function installBridge(mode: unknown, bridgeVersion = 3): void {
	(globalThis as { __vcpdeckPiHost?: unknown }).__vcpdeckPiHost = {
		bridgeVersion,
		toolExecutionMode: mode,
	};
}

function run(
	pi: FakePi,
	toolName: string,
	approved = false,
	confirm = vi.fn(async () => approved),
): { decision: Promise<Decision>; confirm: ReturnType<typeof vi.fn> } {
	const handler = pi.handlers[0];
	if (!handler) throw new Error("extension did not register a tool_call handler");
	return {
		decision: handler({ toolName }, { ui: { confirm } }),
		confirm,
	};
}

afterEach(() => {
	delete (globalThis as { __vcpdeckPiHost?: unknown }).__vcpdeckPiHost;
});

describe("vcp.tool-policy 扩展 v3（两模式矩阵）", () => {
	it("automatic 下所有已注册工具直接执行且不询问", async () => {
		installBridge("automatic");
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		for (const tool of ["read", "bash", "write", "fixture_echo"]) {
			const { decision, confirm } = await run(pi, tool, true);
			expect(await decision).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		}
	});

	it("supervised 下含读取工具在内的每次调用都要求批准，批准后放行", async () => {
		installBridge("supervised");
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		for (const tool of ["read", "grep", "bash", "fixture_echo"]) {
			const { decision, confirm } = await run(pi, tool, true);
			expect(await decision).toBeUndefined();
			expect(confirm).toHaveBeenCalledTimes(1);
		}
	});

	it("supervised 下拒绝与取消（undefined）一律阻塞，且各问一次", async () => {
		installBridge("supervised");
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		const rejected = run(pi, "bash", false);
		expect(await rejected.decision).toEqual({
			block: true,
			reason: "PI_TOOL_POLICY_REJECTED: bash",
		});
		expect(rejected.confirm).toHaveBeenCalledTimes(1);

		const cancelled = run(pi, "read", undefined as unknown as boolean);
		expect(await cancelled.decision).toEqual({
			block: true,
			reason: "PI_TOOL_POLICY_REJECTED: read",
		});
	});

	it("桥接缺失时全部阻塞（PI_POLICY_UNAVAILABLE，不 fail open）", async () => {
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		const { decision, confirm } = await run(pi, "read");
		expect(await decision).toEqual({
			block: true,
			reason: "PI_POLICY_UNAVAILABLE: read",
		});
		expect(confirm).not.toHaveBeenCalled();
	});

	it("桥接版本不符（v2 旧桥接）时全部阻塞，且不得回退旧语义", async () => {
		// v2 桥接带 toolPolicy 三桶；v3 扩展不得再读取它。
		(globalThis as { __vcpdeckPiHost?: unknown }).__vcpdeckPiHost = {
			bridgeVersion: 2,
			toolPolicy: { allow: ["read"], confirm: [], deny: [] },
			toolExecutionMode: "automatic",
		};
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await (await run(pi, "read")).decision).toEqual({
			block: true,
			reason: "PI_POLICY_UNAVAILABLE: read",
		});
	});

	it.each([
		["模式缺失", undefined],
		["旧模式 approval", "approval"],
		["旧模式 auto", "auto"],
		["旧模式 yolo", "yolo"],
		["未知模式", "unsafe"],
		["模式为非字符串", 1],
	])("%s 时全部阻塞（不放行）", async (_label, mode) => {
		installBridge(mode);
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		const { decision, confirm } = await run(pi, "read", true);
		expect(await decision).toEqual({
			block: true,
			reason: "PI_POLICY_UNAVAILABLE: read",
		});
		expect(confirm).not.toHaveBeenCalled();
	});

	it("模式在 factory 阶段只读取一次（Worker 生命周期内不可变）", async () => {
		installBridge("supervised");
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		// 改写全局不再影响已安装快照：仍然走审批。
		installBridge("automatic");
		const { decision, confirm } = await run(pi, "bash", true);
		expect(await decision).toBeUndefined();
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});
