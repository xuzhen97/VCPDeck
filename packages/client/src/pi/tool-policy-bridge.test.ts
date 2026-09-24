import { describe, expect, it } from "vitest";
import {
	PI_TOOL_POLICY_BRIDGE_VERSION,
	installToolPolicyBridge,
	readToolPolicyBridge,
} from "./tool-policy-bridge.js";

const policy = { allow: ["read"], confirm: ["bash"], deny: ["write"] };

describe("tool-policy bridge（策略 → Bundle 扩展的进程内通道）", () => {
	it("安装后写入带版本的对象", () => {
		const target: Record<string, unknown> = {};
		installToolPolicyBridge(policy, target);

		expect(target.__vcpdeckPiHost).toEqual({
			bridgeVersion: 1,
			toolPolicy: { allow: ["read"], confirm: ["bash"], deny: ["write"] },
		});
	});

	it("读回时做深拷贝（调用方不能改写已安装的策略）", () => {
		const target: Record<string, unknown> = {};
		installToolPolicyBridge(policy, target);

		const first = readToolPolicyBridge(target);
		first?.toolPolicy.allow.push("write");
		expect(readToolPolicyBridge(target)?.toolPolicy.allow).toEqual(["read"]);
	});

	it("未安装时返回 null", () => {
		expect(readToolPolicyBridge({})).toBeNull();
	});

	it("版本不符时返回 null（Bundle 与 Client 错配不得静默放行）", () => {
		const target: Record<string, unknown> = {
			__vcpdeckPiHost: { bridgeVersion: 2, toolPolicy: policy },
		};
		expect(readToolPolicyBridge(target)).toBeNull();
	});

	it("版本常量与写入口径一致", () => {
		expect(PI_TOOL_POLICY_BRIDGE_VERSION).toBe(1);
	});
});
