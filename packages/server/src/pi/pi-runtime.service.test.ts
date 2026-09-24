import { describe, expect, it } from "vitest";
import type { PiProfileInfo, PiProviderInfo, PiRuntimeSpecMessageV3 } from "@vcpdeck/shared";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";
import { PiRuntimeService } from "./pi-runtime.service.js";

const provider: PiProviderInfo = {
	id: "provider-anthropic",
	name: "Anthropic",
	runtimeProviderId: "anthropic",
	protocol: "anthropic-messages",
	baseUrl: null,
	headers: {},
	enabled: true,
	revision: 1,
	models: [
		{ id: "claude-x", name: "Claude X", metadataSource: "catalog" },
		{
			id: "claude-custom",
			name: "Claude Custom",
			metadataSource: "explicit",
			metadata: {
				id: "claude-custom",
				name: "Claude Custom",
				reasoning: false,
				input: ["text"],
				contextWindow: 200000,
				maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {},
			},
		},
	],
	credentialIds: ["c1"],
	boundProfileIds: ["p1"],
	configurationState: "ready",
};

const profile: PiProfileInfo = {
	id: "p1",
	name: "default",
	enabled: true,
	defaultModel: { provider: "anthropic", modelId: "claude-x" },
	allowedModels: [{ provider: "anthropic", modelId: "claude-x" }],
	defaultThinkingLevel: "medium",
	enabledResourceIds: [],
	toolPolicy: { allow: [], confirm: [], deny: [] },
	revision: 2,
	credentialIds: ["c1"],
	boundClientIds: ["client-1"],
};

function makeService(
	options: {
		profile?: PiProfileInfo | null;
		entries?: Array<{ providerId: string; apiKey: string }>;
		bindings?: Array<{ clientId: string; profileId: string }>;
	} = {},
) {
	const sent: Array<{ socketId: string; message: PiRuntimeSpecMessageV3 | null }> = [];
	const revoked: string[] = [];
	const snapshotCalls: string[][] = [];
	const registry = new PiRuntimeRegistry();
	const prisma = {
		piCredential: {
			findMany: async () =>
				options.profile?.credentialIds.length
					? [
							{
								id: "c1",
								updatedAt: new Date("2026-09-20T00:00:00Z"),
								revokedAt: null,
							},
						]
					: [],
		},
		piClientBinding: { findMany: async () => options.bindings ?? [] },
	};
	const profiles = {
		resolveBoundProfile: async () => options.profile ?? null,
	};
	const credentials = {
		resolveSecrets: async () => options.entries ?? [],
	};
	const service = new PiRuntimeService(
		prisma as never,
		profiles as never,
		{
			getRuntimeSnapshot: async (ids: string[]) => {
				snapshotCalls.push(ids);
				return [provider];
			},
		} as never,
		credentials as never,
		registry,
	);
	service.bindSender((socketId, message) => {
		sent.push({ socketId, message });
	});
	registry.setCapability("client-1", {
		piSdkVersion: "0.86.0",
		runtimeSpecProtocolVersion: 3,
		configMode: "server-authoritative",
	});
	registry.bindSocket("client-1", "client-1");
	for (const binding of options.bindings ?? []) {
		registry.setCapability(binding.clientId, {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 3,
			configMode: "server-authoritative",
		});
		registry.bindSocket(binding.clientId, binding.clientId);
	}
	return { service, registry, sent, revoked, snapshotCalls };
}

describe("PiRuntimeService", () => {
	it("有绑定且启用时下发 Spec 与凭据 lease，并登记 desired", async () => {
		const { service, registry, sent, snapshotCalls } = makeService({
			profile,
			entries: [{ providerId: "anthropic", apiKey: "sk-live-abc" }],
		});
		await service.pushTo("client-1");

		// 快照必须按 runtimeProviderId 请求（不是表行 id），否则真实环境下会 Provider 不存在
		expect(snapshotCalls[0]).toEqual(["anthropic"]);
		// 下发后状态必须噂带 Provider 摘要（setDesired 会清空它，故顺序不能颠倒）
		expect(registry.status("client-1").providers).toEqual([
			{
				providerId: "anthropic",
				name: "Anthropic",
				runtimeProviderId: "anthropic",
				protocol: "anthropic-messages",
				modelCount: 2,
			},
		]);

		expect(sent).toHaveLength(1);
		expect(sent[0].socketId).toBe("client-1");
		const message = sent[0]?.message;
		expect(message).not.toBeNull();
		expect(message?.spec).toMatchObject({
			schemaVersion: 3,
			profileId: "p1",
			profileRevision: 2,
			// 策略必须随 Spec 下发，即使三桶为空（空策略 = 未列出工具全部拒绝）
			toolPolicy: { allow: [], confirm: [], deny: [] },
		});
		expect(message?.credentials.entries).toEqual([
			{ providerId: "anthropic", apiKey: "sk-live-abc" },
		]);
		expect(registry.status("client-1")).toMatchObject({
			configState: "pending",
			desiredRuntimeRevision: message?.spec.runtimeRevision,
		});
	});

	it("无绑定时登记 desired=null 且不下发任何消息（Pi 不可用，不 fallback）", async () => {
		const { service, registry, sent } = makeService({ profile: null });
		await service.pushTo("client-1");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toBeNull();
		expect(registry.status("client-1")).toMatchObject({
			desiredRuntimeRevision: null,
			configState: "pending",
		});
		expect(() => registry.assertReady("client-1")).toThrow();
	});

	it("Profile 被禁用时同样不下发", async () => {
		const { service, sent } = makeService({
			profile: { ...profile, enabled: false },
		});
		await service.pushTo("client-1");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toBeNull();
	});

	it("无可用凭据时清空 desired，不发送不完整的 RuntimeSpec", async () => {
		const { service, sent, registry } = makeService({ profile, entries: [] });
		await service.pushTo("client-1");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toBeNull();
		expect(registry.status("client-1")).toMatchObject({
			desiredRuntimeRevision: null,
			configState: "pending",
			reasonCode: "PI_CREDENTIAL_UNAVAILABLE",
		});
	});

	it("onClientRegistered 登记 capability 并下发", async () => {
		const { service, registry, sent } = makeService({ profile });
		await service.onClientRegistered("client-1", {
			available: true,
			sdkVersion: "0.86.0",
			nodeVersion: "22.19.0",
			shellKind: "git-bash",
			runtimeSpecProtocolVersion: 3,
			configMode: "server-authoritative",
		}, "socket-1");
		expect(sent).toHaveLength(1);
		expect(registry.status("client-1")).toMatchObject({
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 3,
		});
	});

	it("旧 Client（缺 runtimeSpecProtocolVersion）不登记协议兼容信息", async () => {
		const { service, registry } = makeService({ profile });
		await service.onClientRegistered("client-1", {
			available: true,
			sdkVersion: "0.84.0",
			nodeVersion: "22.19.0",
			shellKind: "git-bash",
		});
		expect(registry.status("client-1").runtimeSpecProtocolVersion).toBeNull();
	});

	it("绑定变化后对所有绑定该 Profile 的 Client 重新下发", async () => {
		const { service, sent } = makeService({
			profile,
			bindings: [
				{ clientId: "client-1", profileId: "p1" },
				{ clientId: "client-2", profileId: "p1" },
			],
		});
		service["registry"].setCapability("client-2", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 3,
			configMode: "server-authoritative",
		});
		service["registry"].bindSocket("client-2", "client-2");
		await service.pushToBoundClients("p1");
		expect(sent.map((item) => item.socketId).sort()).toEqual([
			"client-1",
			"client-2",
		]);
	});

	it("断开后清除状态（重连前保持 pending）", async () => {
		const { service, registry } = makeService({
			profile,
			entries: [{ providerId: "anthropic", apiKey: "sk-a" }],
		});
		await service.pushTo("client-1");
		registry.applyAck({
			clientId: "client-1",
			specId: registry.status("client-1").specId!,
			runtimeRevision: registry.status("client-1").desiredRuntimeRevision!,
			configState: "ready",
			activeRuntimeRevision: registry.status("client-1").desiredRuntimeRevision!,
		});
		expect(() => service.assertReady("client-1")).not.toThrow();
		service.onDisconnected("client-1");
		expect(registry.status("client-1").configState).toBe("pending");
	});

	it("重复连接：绑定 socket 断开时切给存活 socket、恢复其能力并重新下发", async () => {
		const { service, registry, sent } = makeService({
			profile,
			entries: [{ providerId: "anthropic", apiKey: "sk-a" }],
		});
		await service.pushTo("client-1");
		const afterFirstPush = sent.length;
		// 同一 clientId 的第二个重复连接接管注册表
		registry.bindSocket("client-1", "socket-2");
		expect(registry.socketFor("client-1")).toBe("socket-2");

		await service.onDisconnected("client-1", "socket-2");
		// 存活 socket 接管：登记不被清空，且向存活连接重新下发（否则存活的 Client 会永久停在 pending）
		expect(registry.socketFor("client-1")).toBe("client-1");
		expect(registry.isCompatible("client-1")).toBe(true);
		expect(registry.status("client-1").desiredRuntimeRevision).not.toBeNull();
		expect(sent.length).toBeGreaterThan(afterFirstPush);
		expect(sent.at(-1)?.socketId).toBe("client-1");

		await service.onDisconnected("client-1", "client-1");
		expect(registry.isCompatible("client-1")).toBe(false);
		expect(registry.status("client-1").configState).toBe("pending");
	});
});

describe("PiRuntimeService 的 Bundle 门控（fail closed）", () => {
	const bundleCapability = {
		protocolVersion: 1,
		bundleVersion: "0.11.0",
		piSdkVersion: "0.86.0",
		resourceIds: ["vcp.tool-policy"],
	};

	it("Profile 需要资源但 Client 未上报 Bundle 时不下发", async () => {
		const { service, registry, sent } = makeService({
			profile: {
				...profile,
				enabledResourceIds: ["vcp.tool-policy"],
				toolPolicy: { allow: [], confirm: ["bash"], deny: [] },
			},
			entries: [{ providerId: "anthropic", apiKey: "sk-live-abc" }],
		});
		await service.pushTo("client-1");

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toBeNull();
		expect(registry.status("client-1").desiredRuntimeRevision).toBeNull();
		expect(registry.status("client-1").reasonCode).toBe("PI_BUNDLE_UNAVAILABLE");
	});

	it("Bundle 资源未覆盖 Profile 需求时不下发", async () => {
		const { service, registry, sent } = makeService({
			profile: { ...profile, enabledResourceIds: ["vcp.other"] },
			entries: [{ providerId: "anthropic", apiKey: "sk-live-abc" }],
		});
		registry.setBundle("client-1", bundleCapability);
		await service.pushTo("client-1");

		expect(sent[0]?.message).toBeNull();
		expect(registry.status("client-1").desiredRuntimeRevision).toBeNull();
		expect(registry.status("client-1").reasonCode).toBe("PI_BUNDLE_UNAVAILABLE");
	});

	it("Bundle 覆盖时下发 v3 并带上 requiredBundle 与策略", async () => {
		const { service, registry, sent } = makeService({
			profile: {
				...profile,
				enabledResourceIds: ["vcp.tool-policy"],
				toolPolicy: { allow: ["read"], confirm: ["bash"], deny: [] },
			},
			entries: [{ providerId: "anthropic", apiKey: "sk-live-abc" }],
		});
		registry.setBundle("client-1", bundleCapability);
		await service.pushTo("client-1");

		const spec = sent[0]?.message?.spec;
		expect(spec?.schemaVersion).toBe(3);
		expect(spec?.toolPolicy).toEqual({ allow: ["read"], confirm: ["bash"], deny: [] });
		expect(spec?.requiredBundle).toEqual({
			protocolVersion: 1,
			bundleVersion: "0.11.0",
			resourceIds: ["vcp.tool-policy"],
		});
		expect(registry.bundleFor("client-1")).toEqual(bundleCapability);
	});

	it("协议版本低于 3 的 Client 一律不下发任何 Spec", async () => {
		const { service, registry, sent } = makeService({
			profile,
			entries: [{ providerId: "anthropic", apiKey: "sk-live-abc" }],
		});
		// 模拟升级前仍在运行的旧 Client（能力摘要上报 2）
		registry.setCapability("client-1", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 2,
			configMode: "server-authoritative",
		});
		await service.pushTo("client-1");

		// 不兼容的 Client 连空 Spec 也不发（emit 先校验 isCompatible），desired 登记为 null
		expect(sent).toHaveLength(0);
		expect(registry.isCompatible("client-1")).toBe(false);
		expect(
			registry.status("client-1").desiredRuntimeRevision,
		).toBeNull();
	});

	it("注册时上报协议 2 的 Client 被标记为不兼容，并给出原因", async () => {
		const { service, registry } = makeService({ profile });
		await service.onClientRegistered(
			"client-old",
			{
				available: true,
				sdkVersion: "0.86.0",
				nodeVersion: "22.19.0",
				shellKind: "system",
				runtimeSpecProtocolVersion: 2,
				configMode: "server-authoritative",
			},
			"socket-old",
		);

		expect(registry.isCompatible("client-old")).toBe(false);
		expect(registry.status("client-old")).toMatchObject({
			configState: "incompatible",
			reasonCode: "PI_CLIENT_UNSUPPORTED",
		});
	});

	it("reportedResourceIds 汇总所有已上报的 Bundle 资源", () => {
		const { registry } = makeService({ profile });
		registry.setBundle("client-1", bundleCapability);
		registry.setBundle("client-2", {
			...bundleCapability,
			resourceIds: ["vcp.tool-policy", "vcp.other"],
		});
		expect([...registry.reportedResourceIds()].sort()).toEqual([
			"vcp.other",
			"vcp.tool-policy",
		]);
	});
});
