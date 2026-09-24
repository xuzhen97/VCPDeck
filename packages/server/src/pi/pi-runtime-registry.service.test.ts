import { describe, expect, it } from "vitest";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";

describe("PiRuntimeRegistry", () => {
	it("未知 client 的状态为 pending（等价 Server 重启后 registry 为空）", () => {
		const registry = new PiRuntimeRegistry();
		expect(registry.status("unknown")).toEqual({
			clientId: "unknown",
			specId: null,
			desiredRuntimeRevision: null,
			activeRuntimeRevision: null,
			configState: "pending",
			reasonCode: null,
			piSdkVersion: null,
			runtimeSpecProtocolVersion: null,
			providers: [],
		unavailableModels: [],
		});
	});

	it("未就绪时 assertReady 拒绝，收到 ready ACK 后放行，clear 后复位", () => {
		const registry = new PiRuntimeRegistry();
		registry.setCapability("c1", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 4,
			configMode: "server-authoritative",
		});
		registry.setDesired("c1", { specId: "s1", runtimeRevision: "0123456789abcdef" });

		registry.bindSocket("c1", "socket-1");
		registry.applyAck({
			clientId: "c1",
			specId: "s1",
			runtimeRevision: "0123456789abcdef",
			configState: "ready",
			resolvedModels: [{ provider: "anthropic", modelId: "claude-x" }],
			activeRuntimeRevision: "0123456789abcdef",
		});
		expect(() => registry.assertReady("c1")).not.toThrow();
		expect(registry.status("c1")).toMatchObject({
			configState: "ready",
			activeRuntimeRevision: "0123456789abcdef",
		});

		registry.clear("c1");
		expect(registry.status("c1").configState).toBe("pending");
	});

	it("无绑定时 setDesired(null) 使 Pi 不可用且不残留旧 ACK", () => {
		const registry = new PiRuntimeRegistry();
		registry.setDesired("c1", { specId: "s1", runtimeRevision: "0123456789abcdef" });
		registry.applyAck({
			clientId: "c1",
			specId: "s1",
			runtimeRevision: "0123456789abcdef",
			configState: "ready",
		});
		registry.setDesired("c1", null);
		expect(registry.status("c1")).toMatchObject({
			specId: null,
			desiredRuntimeRevision: null,
			configState: "pending",
		});
		expect(() => registry.assertReady("c1")).toThrow();
	});

	it("incompatible ACK 记录 reasonCode 与缺失模型，且不放行", () => {
		const registry = new PiRuntimeRegistry();
		registry.setDesired("c1", { specId: "s1", runtimeRevision: "0123456789abcdef" });
		registry.applyAck({
			clientId: "c1",
			specId: "s1",
			runtimeRevision: "0123456789abcdef",
			configState: "incompatible",
			reasonCode: "PI_CREDENTIAL_UNAVAILABLE",
			unavailableModels: [
				{ provider: "anthropic", modelId: "claude-x", reason: "model_unavailable" },
			],
		});
		expect(registry.status("c1")).toMatchObject({
			configState: "incompatible",
			reasonCode: "PI_CREDENTIAL_UNAVAILABLE",
			unavailableModels: [
				{ provider: "anthropic", modelId: "claude-x", reason: "model_unavailable" },
			],
		});
		expect(() => registry.assertReady("c1")).toThrow();
	});

	it("过期 specId 的 ACK 不覆盖较新的 desired revision", () => {
		const registry = new PiRuntimeRegistry();
		registry.setDesired("c1", { specId: "s2", runtimeRevision: "2222222222222222" });
		registry.bindSocket("c1", "socket-1");
		registry.applyAck({
			clientId: "c1",
			specId: "s1",
			runtimeRevision: "1111111111111111",
			configState: "ready",
		});
		expect(registry.status("c1")).toMatchObject({
			specId: "s2",
			desiredRuntimeRevision: "2222222222222222",
			configState: "pending",
		});
	});

	it("PI_STATE 只更新 active revision 与 configState", () => {
		const registry = new PiRuntimeRegistry();
		registry.setCapability("c1", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 4,
			configMode: "server-authoritative",
		});
		registry.setDesired("c1", { specId: "s1", runtimeRevision: "0123456789abcdef" });
		registry.bindSocket("c1", "socket-1");
		registry.applyAck({
			clientId: "c1",
			specId: "s1",
			runtimeRevision: "0123456789abcdef",
			configState: "ready",
			activeRuntimeRevision: "0123456789abcdef",
		});
		expect(registry.status("c1")).toMatchObject({
			configState: "ready",
			activeRuntimeRevision: "0123456789abcdef",
		});
		expect(() => registry.assertReady("c1")).not.toThrow();
	});

	it("client capability 版本信息可登记（piSdkVersion / 协议版本）", () => {
		const registry = new PiRuntimeRegistry();
		registry.setCapability("c1", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 4,
		});
		expect(registry.status("c1")).toMatchObject({
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 4,
		});
	});

	it("重复连接：注册重置不清空连接事实，绑定 socket 关闭时切给存活 socket 并恢复其能力", () => {
		const registry = new PiRuntimeRegistry();
		// 好连接：完整能力（含 Bundle）
		registry.bindSocket("c1", "socket-1");
		registry.setCapability("c1", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 4,
			configMode: "server-authoritative",
		});
		registry.setBundle("c1", {
			protocolVersion: 1,
			bundleVersion: "0.10.5-dev",
			piSdkVersion: "0.86.0",
			resourceIds: ["vcp.tool-policy"],
		});
		// 幽灵连接（无 Bundle）最后注册：清空条目并接管绑定
		registry.clear("c1");
		registry.bindSocket("c1", "socket-2");
		registry.setCapability("c1", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 4,
			configMode: "server-authoritative",
		});
		expect(registry.bundleFor("c1")).toBeNull();
		expect(registry.socketFor("c1")).toBe("socket-2");

		// 幽灵断开：绑定切回存活连接，并恢复它自己的能力（不是被杀连接的）
		expect(registry.clearSocket("c1", "socket-2")).toBe("socket-1");
		expect(registry.socketFor("c1")).toBe("socket-1");
		expect(registry.isCompatible("c1")).toBe(true);
		expect(registry.bundleFor("c1")?.resourceIds).toEqual(["vcp.tool-policy"]);

		// 非绑定 socket 关闭不影响登记
		expect(registry.clearSocket("c1", "socket-9")).toBeNull();
		expect(registry.socketFor("c1")).toBe("socket-1");
		// 最后一个 socket 关闭才清除
		expect(registry.clearSocket("c1", "socket-1")).toBeNull();
		expect(registry.isCompatible("c1")).toBe(false);
		expect(registry.status("c1").configState).toBe("pending");
	});

	it("forget 清空全部连接事实，clear 只重置条目", () => {
		const registry = new PiRuntimeRegistry();
		registry.bindSocket("c1", "socket-1");
		registry.setCapability("c1", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 4,
			configMode: "server-authoritative",
		});
		registry.clear("c1");
		expect(registry.socketFor("c1")).toBeNull();
		expect(registry.isCompatible("c1")).toBe(false);
		// clear 后该 socket 仍被记住，因此它断开时不会误判为「无存活者」
		expect(registry.clearSocket("c1", "socket-1")).toBeNull();

		registry.bindSocket("c2", "socket-2");
		registry.forget("c2");
		expect(registry.socketFor("c2")).toBeNull();
		expect(registry.isCompatible("c2")).toBe(false);
	});

	it("setReason 只改写 reasonCode，不动 desired / configState", () => {
		const registry = new PiRuntimeRegistry();
		registry.setDesired("c1", { specId: "s1", runtimeRevision: "0123456789abcdef" });
		registry.setReason("c1", "PI_BUNDLE_UNAVAILABLE");
		expect(registry.status("c1")).toMatchObject({
			reasonCode: "PI_BUNDLE_UNAVAILABLE",
			desiredRuntimeRevision: "0123456789abcdef",
			configState: "pending",
		});
		registry.setReason("c1", null);
		expect(registry.status("c1").reasonCode).toBeNull();
	});
});
