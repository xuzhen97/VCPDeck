import { describe, expect, it, vi } from "vitest";
import { probePiCapability, type ProbeEnv } from "./capability.js";

function fakeEnv(overrides: Partial<ProbeEnv> = {}): ProbeEnv {
	return {
		nodeVersion: "22.19.0",
		platform: "win32",
		existsGitBash: async () => false,
		findBashInPath: async () => false,
		forkProbeWorker: async () => ({ sdkVersion: "0.86.0", providerIds: ["anthropic", "openai"], error: null }),
		ensureDataRootWritable: async () => true,
		resolveBundle: async () => null,
		...overrides,
	};
}

describe("probePiCapability", () => {
	it("Windows 全满足时返回 available + git-bash 来源 + 隔离模式字段", async () => {
		const result = await probePiCapability(
			fakeEnv({ existsGitBash: async () => true }),
		);
		expect(result).toMatchObject({
			available: true,
			sdkVersion: "0.86.0",
			nodeVersion: "22.19.0",
			shellKind: "git-bash",
			sessionJobProtocolVersion: 1,
			runtimeSpecProtocolVersion: 4,
			configMode: "server-authoritative",
		});
	});

	it("PATH bash 作为最后来源", async () => {
		const result = await probePiCapability(
			fakeEnv({ findBashInPath: async () => true }),
		);
		expect(result).toMatchObject({ available: true, shellKind: "path" });
	});

	it("Linux 使用 system bash（bash 在 PATH）", async () => {
		const result = await probePiCapability(
			fakeEnv({
				platform: "linux",
				existsGitBash: async () => true,
				findBashInPath: async () => true,
			}),
		);
		expect(result).toMatchObject({ available: true, shellKind: "system" });
	});

	it("Linux 无 bash 返回 PI_BASH_NOT_FOUND", async () => {
		const result = await probePiCapability(
			fakeEnv({
				platform: "linux",
				existsGitBash: async () => true,
				findBashInPath: async () => false,
			}),
		);
		expect(result).toMatchObject({
			available: false,
			code: "PI_BASH_NOT_FOUND",
		});
	});

	it("Node 过旧返回 PI_NODE_UNSUPPORTED", async () => {
		const result = await probePiCapability(fakeEnv({ nodeVersion: "22.18.99" }));
		expect(result).toMatchObject({
			available: false,
			code: "PI_NODE_UNSUPPORTED",
			nodeVersion: "22.18.99",
		});
	});

	it("Windows 找不到 Bash 返回 PI_BASH_NOT_FOUND", async () => {
		const result = await probePiCapability(fakeEnv({}));
		expect(result).toMatchObject({
			available: false,
			code: "PI_BASH_NOT_FOUND",
		});
		expect(result).not.toHaveProperty("sessionJobProtocolVersion");
	});

	it("Worker 失败返回 PI_RUNTIME_UNAVAILABLE", async () => {
		const result = await probePiCapability(
			fakeEnv({
				existsGitBash: async () => true,
				forkProbeWorker: async () => ({
					sdkVersion: "",
					providerIds: [],
					error: {
						code: "PI_RUNTIME_UNAVAILABLE",
						message: "sdk load failed",
					},
				}),
			}),
		);
		expect(result).toMatchObject({
			available: false,
			code: "PI_RUNTIME_UNAVAILABLE",
		});
	});

	it("VCPDeck data root 不可写返回 PI_RUNTIME_UNAVAILABLE，且不回退用户 Pi", async () => {
		const result = await probePiCapability(
			fakeEnv({
				existsGitBash: async () => true,
				ensureDataRootWritable: async () => false,
			}),
		);
		expect(result).toMatchObject({
			available: false,
			code: "PI_RUNTIME_UNAVAILABLE",
		});
	});

	it("本机无已认证模型不再判定不可用（判定迁移到 RuntimeSpec ready）", async () => {
		// 探测结果只保留 SDK 版本；模型可用性由 Server 下发的 RuntimeSpec 决定。
		const forkProbeWorker = vi.fn(async () => ({
			sdkVersion: "0.86.0",
			providerIds: ["anthropic", "openai"],
			error: null,
		}));
		const result = await probePiCapability(
			fakeEnv({ existsGitBash: async () => true, forkProbeWorker }),
		);
		expect(result.available).toBe(true);
		expect(forkProbeWorker).toHaveBeenCalledOnce();
	});

	it("结果字段集合固定，不含路径或凭据", async () => {
		const result = await probePiCapability(
			fakeEnv({ existsGitBash: async () => true }),
		);
		expect(Object.keys(result).sort()).toEqual([
			"available",
			"configMode",
			"modelCatalog",
			"nodeVersion",
			"runtimeSpecProtocolVersion",
			"sdkVersion",
			"sessionJobProtocolVersion",
			"shellKind",
		]);
		// modelCatalog 只包含 SDK 版本与 Provider ID，不含模型元数据。
		expect(
			(
				result as { modelCatalog?: { providerIds: string[] } }
			).modelCatalog?.providerIds,
		).toEqual(["anthropic", "openai"]);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("Users");
		expect(serialized).not.toContain("AppData");
		expect(serialized).not.toContain(".pi");
	});
});

describe("probePiCapability 的 Bundle 能力上报", () => {
	const verified = {
		root: "/app/apps/0.11.0/pi-resources",
		manifest: {
			protocolVersion: 1,
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resources: [],
		},
		resourceIds: ["vcp.tool-policy"],
		extensionPaths: ["/app/apps/0.11.0/pi-resources/extensions/vcp-tool-policy/index.js"],
	};

	it("校验通过时上报 bundle 能力（只含版本事实与资源 ID）", async () => {
		const status = await probePiCapability(
			fakeEnv({
				platform: "linux",
				findBashInPath: async () => true,
				resolveBundle: async () => verified,
			}),
		);

		expect(status.available).toBe(true);
		if (!status.available) throw new Error("expected available");
		expect(status.bundle).toEqual({
			protocolVersion: 1,
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resourceIds: ["vcp.tool-policy"],
		});
		expect(JSON.stringify(status.bundle)).not.toContain("extensions/");
	});

	it("无可用 Bundle 时不带 bundle 字段（Pi 本身仍可用）", async () => {
		const status = await probePiCapability(
			fakeEnv({
				platform: "linux",
				findBashInPath: async () => true,
				resolveBundle: async () => null,
			}),
		);

		expect(status.available).toBe(true);
		if (!status.available) throw new Error("expected available");
		expect(status.bundle).toBeUndefined();
	});

	it("SDK 版本未知（探针失败）时不解析 Bundle", async () => {
		let called = false;
		const status = await probePiCapability(
			fakeEnv({
				platform: "linux",
				findBashInPath: async () => true,
				forkProbeWorker: async () => ({
					sdkVersion: "",
					providerIds: [],
					error: { code: "PI_RUNTIME_UNAVAILABLE", message: "boom" },
				}),
				resolveBundle: async () => {
					called = true;
					return verified;
				},
			}),
		);

		expect(status.available).toBe(false);
		expect(called).toBe(false);
	});
});
