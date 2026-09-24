import { afterEach, describe, expect, it, vi } from "vitest";
import toolPolicyExtension from "./index.js";

type Decision = { block?: boolean; reason?: string } | undefined;
type ExecutionMode = "approval" | "auto" | "yolo";
type Policy = { allow: string[]; confirm: string[]; deny: string[] };

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

function installBridge(
	mode: unknown,
	policy: unknown,
	bridgeVersion: number = 2,
): void {
	(globalThis as { __vcpdeckPiHost?: unknown }).__vcpdeckPiHost = {
		bridgeVersion,
		toolPolicy: policy,
		toolExecutionMode: mode,
	};
}

/** 基线策略：read=allow，bash=confirm，write=deny，grep 未列出。 */
const basePolicy: Policy = { allow: ["read"], confirm: ["bash"], deny: ["write"] };

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

describe("vcp.tool-policy 扩展 v2（策略 × 执行模式矩阵）", () => {
	it.each([
		// 模式, 本轮 Model 调用的工具, 期望阻塞原因（undefined = 直接执行）
		["auto", "read", undefined],
		["auto", "bash", undefined],
		["auto", "write", "PI_TOOL_POLICY_DENIED: write"],
		["auto", "grep", "PI_TOOL_POLICY_DENIED: grep"],
		["approval", "read", undefined],
		["approval", "write", "PI_TOOL_POLICY_DENIED: write"],
		["approval", "grep", "PI_TOOL_POLICY_DENIED: grep"],
		["yolo", "read", undefined],
		["yolo", "bash", undefined],
		["yolo", "write", undefined],
		["yolo", "grep", undefined],
	] as const)("%s 模式下 %s 的判定", async (mode, tool, reason) => {
		installBridge(mode, basePolicy);
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		const { decision, confirm } = await run(pi, tool, true);
		expect(await decision).toEqual(
			reason === undefined ? undefined : { block: true, reason },
		);
		// YOLO 与 Auto 不得因 Tool Policy 产生任何审批
		if (mode === "yolo" || reason !== undefined || tool !== "bash") {
			expect(confirm).not.toHaveBeenCalled();
		}
	});

	it("approval 模式下 confirm 工具：批准后执行、拒绝后阻塞，且各问一次", async () => {
		installBridge("approval", basePolicy);
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		const approved = run(pi, "bash", true);
		expect(await approved.decision).toBeUndefined();
		expect(approved.confirm).toHaveBeenCalledTimes(1);

		const rejected = run(pi, "bash", false);
		expect(await rejected.decision).toEqual({
			block: true,
			reason: "PI_TOOL_POLICY_REJECTED: bash",
		});
		expect(rejected.confirm).toHaveBeenCalledTimes(1);
	});

	it("auto 模式下 confirm 工具直接执行且不询问", async () => {
		installBridge("auto", basePolicy);
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		const auto = run(pi, "bash", true);
		expect(await auto.decision).toBeUndefined();
		expect(auto.confirm).not.toHaveBeenCalled();
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

	it("桥接版本不符（v1）时全部阻塞，且不得回退旧语义", async () => {
		installBridge("auto", basePolicy, 1);
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		expect(await (await run(pi, "read")).decision).toEqual({
			block: true,
			reason: "PI_POLICY_UNAVAILABLE: read",
		});
	});

	it.each([
		["模式缺失", undefined, basePolicy],
		["模式非法", "unsafe", basePolicy],
		["策略形状非法", "auto", { allow: ["read"] }],
		["策略桶非数组", "auto", { allow: "read", confirm: [], deny: [] }],
		["策略桶含非字符串", "auto", { allow: [1], confirm: [], deny: [] }],
	] as const)("%s 时全部阻塞（不放行）", async (_label, mode, policy) => {
		installBridge(mode, policy);
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		const { decision, confirm } = await run(pi, "read", true);
		expect(await decision).toEqual({
			block: true,
			reason: "PI_POLICY_UNAVAILABLE: read",
		});
		expect(confirm).not.toHaveBeenCalled();
	});

	it("策略在 factory 阶段只读取一次（Worker 生命周期内不可变）", async () => {
		installBridge("approval", basePolicy);
		const pi = fakePi();
		toolPolicyExtension(pi as never);

		installBridge("auto", basePolicy);
		// 已安装快照不因全局对象被改写而改变：confirm 工具仍走审批
		const { decision, confirm } = await run(pi, "bash", true);
		expect(await decision).toBeUndefined();
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});
