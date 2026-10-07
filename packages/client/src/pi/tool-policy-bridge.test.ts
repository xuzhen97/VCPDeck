import { describe, expect, it } from "vitest";
import {
	PI_TOOL_POLICY_BRIDGE_VERSION,
	installToolPolicyBridge,
	readToolPolicyBridge,
} from "./tool-policy-bridge.js";

describe("tool-policy bridge v3（执行模式 → Bundle 扩展的进程内通道）", () => {
	it("安装后写入带版本的对象（只含执行模式，无逐工具策略）", () => {
		const target: Record<string, unknown> = {};
		installToolPolicyBridge("supervised", target);

		expect(target.__vcpdeckPiHost).toEqual({
			bridgeVersion: 3,
			toolExecutionMode: "supervised",
		});
		// 三桶已删除（ADR-0039）：桥接不得再携带任何工具名单。
		expect(target.__vcpdeckPiHost).not.toHaveProperty("toolPolicy");
	});

	it("读回两模式", () => {
		const target: Record<string, unknown> = {};
		installToolPolicyBridge("automatic", target);
		expect(readToolPolicyBridge(target)?.toolExecutionMode).toBe("automatic");
	});

	it("未安装时返回 null", () => {
		expect(readToolPolicyBridge({})).toBeNull();
	});

	it("旧 v2 桥接返回 null（不得回退三桶语义）", () => {
		expect(
			readToolPolicyBridge({
				__vcpdeckPiHost: {
					bridgeVersion: 2,
					toolPolicy: { allow: ["read"], confirm: [], deny: [] },
					toolExecutionMode: "auto",
				},
			}),
		).toBeNull();
	});

	it("缺少、旧值或非法执行模式时返回 null（不猜默认模式）", () => {
		expect(
			readToolPolicyBridge({ __vcpdeckPiHost: { bridgeVersion: 3 } }),
		).toBeNull();
		for (const mode of ["auto", "yolo", "approval", "unsafe", 1]) {
			expect(
				readToolPolicyBridge({
					__vcpdeckPiHost: { bridgeVersion: 3, toolExecutionMode: mode },
				}),
			).toBeNull();
		}
	});

	it("版本常量与写入口径一致", () => {
		expect(PI_TOOL_POLICY_BRIDGE_VERSION).toBe(3);
	});
});
