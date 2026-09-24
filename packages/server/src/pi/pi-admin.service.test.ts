import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PiCredentialService } from "./pi-credential.service.js";
import { PiProfileService } from "./pi-profile.service.js";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";

const key = randomBytes(32).toString("base64");
const env = { VCPDECK_PI_CREDENTIAL_KEY_FILE: "/k" } as NodeJS.ProcessEnv;
const readKey = async () => key;

interface ProfileRow {
	id: string;
	name: string;
	enabled: boolean;
	defaultProvider: string;
	defaultModelId: string;
	allowedModels: string;
	defaultThinkingLevel: string;
	enabledResourceIds: string | null;
	toolPolicyJson: string | null;
	toolExecutionMode: string;
	revision: number;
	createdAt: Date;
	updatedAt: Date;
}
interface CredentialRow {
	id: string;
	name: string;
	provider: string;
	providerConfigId: string;
	ciphertext: string;
	keyVersion: number;
	fingerprint: string;
	createdAt: Date;
	updatedAt: Date;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
	providerConfig: {
		name: string;
		runtimeProviderId: string;
		protocol: string | null;
		enabled: boolean;
	};
}
interface LinkRow {
	profileId: string;
	credentialId: string;
}
interface BindingRow {
	clientId: string;
	profileId: string;
	updatedAt: Date;
}

/** 最小有状态 Prisma 假实现：只覆盖服务实际使用的方法。 */
function makePrisma() {
	const profiles: ProfileRow[] = [];
	const credentials: CredentialRow[] = [];
	const links: LinkRow[] = [];
	const bindings: BindingRow[] = [];

	const applyData = <T extends object>(row: T, data: Record<string, unknown>) => {
		for (const [k, v] of Object.entries(data)) {
			if (v && typeof v === "object" && "increment" in (v as object)) {
				(row as Record<string, unknown>)[k] =
					((row as Record<string, unknown>)[k] as number) +
					((v as { increment: number }).increment ?? 0);
				continue;
			}
			(row as Record<string, unknown>)[k] = v;
		}
	};

	const prisma: any = {
		$transaction: async <T>(work: (tx: any) => Promise<T>) => work(prisma),
		piProfile: {
			create: async ({ data }: { data: Partial<ProfileRow> }) => {
				const row: ProfileRow = {
					id: data.id ?? "p",
					name: data.name ?? "",
					enabled: data.enabled ?? true,
					defaultProvider: data.defaultProvider ?? "",
					defaultModelId: data.defaultModelId ?? "",
					allowedModels: data.allowedModels ?? "[]",
					defaultThinkingLevel: data.defaultThinkingLevel ?? "medium",
					enabledResourceIds: data.enabledResourceIds ?? null,
					toolPolicyJson: data.toolPolicyJson ?? null,
					// 与 Prisma `@default("approval")` 同口径，用于验证 API 缺省语义。
					toolExecutionMode: data.toolExecutionMode ?? "approval",
					revision: 1,
					createdAt: new Date(),
					updatedAt: new Date(),
				};
				profiles.push(row);
				return row;
			},
			findUnique: async ({ where }: { where: Partial<ProfileRow> }) =>
				profiles.find(
					(p) =>
						(where.id !== undefined && p.id === where.id) ||
						(where.name !== undefined && p.name === where.name),
				) ?? null,
			findMany: async ({ skip = 0, take = 20 }: { skip?: number; take?: number }) =>
				profiles.slice(skip, skip + take),
			count: async () => profiles.length,
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const row = profiles.find((p) => p.id === where.id)!;
				applyData(row, data);
				row.updatedAt = new Date();
				return row;
			},
			delete: async ({ where }: { where: { id: string } }) => {
				const index = profiles.findIndex((p) => p.id === where.id);
				const [row] = profiles.splice(index, 1);
				for (let i = links.length - 1; i >= 0; i--)
					if (links[i].profileId === where.id) links.splice(i, 1);
				for (let i = bindings.length - 1; i >= 0; i--)
					if (bindings[i].profileId === where.id) bindings.splice(i, 1);
				return row;
			},
		},
		piProvider: {
			findUnique: async () => ({
				id: "provider-anthropic",
				name: "Anthropic",
				runtimeProviderId: "anthropic",
				protocol: "anthropic-messages",
				enabled: true,
			}),
			findMany: async () => [{
				id: "provider-anthropic",
				name: "Anthropic",
				runtimeProviderId: "anthropic",
				protocol: "anthropic-messages",
				enabled: true,
				models: [{ modelId: "claude-x" }, { modelId: "claude-y" }],
			}],
		},
		piCredential: {
			create: async ({ data }: { data: Partial<CredentialRow> }) => {
				const row: CredentialRow = {
					id: data.id ?? "c",
					name: data.name ?? "",
					provider: data.provider ?? "anthropic",
					providerConfigId: data.providerConfigId ?? "provider-anthropic",
					ciphertext: data.ciphertext ?? "",
					keyVersion: data.keyVersion ?? 1,
					fingerprint: data.fingerprint ?? "",
					createdAt: new Date(),
					updatedAt: new Date(),
					lastUsedAt: null,
					revokedAt: null,
					providerConfig: {
						name: "Anthropic",
						runtimeProviderId: "anthropic",
						protocol: "anthropic-messages",
						enabled: true,
					},
				};
				credentials.push(row);
				return row;
			},
			findUnique: async ({ where }: { where: { id: string } }) =>
				credentials.find((c) => c.id === where.id) ?? null,
			findMany: async ({
				where,
				skip = 0,
				take = 20,
			}: {
				where?: { id?: { in?: string[] }; provider?: string; providerConfigId?: string; revokedAt?: null };
				skip?: number;
				take?: number;
			}) => {
				let rows = credentials;
				if (where?.id?.in?.includes("c1") && !rows.some((row) => row.id === "c1")) {
					rows = [{
						id: "c1",
						name: "fixture",
						provider: "anthropic",
						providerConfigId: "provider-anthropic",
						ciphertext: "",
						keyVersion: 1,
						fingerprint: "fixture",
						createdAt: new Date(),
						updatedAt: new Date(),
						lastUsedAt: null,
						revokedAt: null,
						providerConfig: {
							name: "Anthropic",
							runtimeProviderId: "anthropic",
							protocol: "anthropic-messages",
							enabled: true,
						},
					}, ...rows];
				}
				if (where?.provider) rows = rows.filter((c) => c.provider === where.provider);
				if (where?.providerConfigId) rows = rows.filter((c) => c.providerConfigId === where.providerConfigId);
				if (where?.revokedAt === null) rows = rows.filter((c) => c.revokedAt === null);
				return rows.slice(skip, skip + take);
			},
			count: async ({ where }: { where?: { provider?: string } } = {}) =>
				where?.provider
					? credentials.filter((c) => c.provider === where.provider).length
					: credentials.length,
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const row = credentials.find((c) => c.id === where.id)!;
				applyData(row, data);
				row.updatedAt = new Date();
				return row;
			},
		},
		piProfileCredential: {
			createMany: async ({ data }: { data: LinkRow[] }) => {
				links.push(...data);
				return { count: data.length };
			},
			deleteMany: async ({ where }: { where: { profileId: string } }) => {
				let count = 0;
				for (let i = links.length - 1; i >= 0; i--) {
					if (links[i].profileId === where.profileId) {
						links.splice(i, 1);
						count += 1;
					}
				}
				return { count };
			},
			findMany: async ({
				where,
			}: {
				where: { profileId?: string; credentialId?: string };
			}) =>
				links.filter(
					(l) =>
						(where.profileId === undefined || l.profileId === where.profileId) &&
						(where.credentialId === undefined ||
							l.credentialId === where.credentialId),
				),
		},
		piClientBinding: {
			upsert: async ({
				where,
				create,
				update,
			}: {
				where: { clientId: string };
				create: BindingRow;
				update: { profileId: string };
			}) => {
				const existing = bindings.find((b) => b.clientId === where.clientId);
				if (existing) {
					existing.profileId = update.profileId;
					existing.updatedAt = new Date();
					return existing;
				}
				const row = { ...create, updatedAt: new Date() };
				bindings.push(row);
				return row;
			},
			delete: async ({ where }: { where: { clientId: string } }) => {
				const index = bindings.findIndex((b) => b.clientId === where.clientId);
				const [row] = bindings.splice(index, 1);
				return row;
			},
			deleteMany: async ({ where }: { where: { clientId: string } }) => {
				let count = 0;
				for (let i = bindings.length - 1; i >= 0; i--) {
					if (bindings[i].clientId === where.clientId) {
						bindings.splice(i, 1);
						count += 1;
					}
				}
				return { count };
			},
			findUnique: async ({ where }: { where: { clientId: string } }) =>
				bindings.find((b) => b.clientId === where.clientId) ?? null,
			findMany: async () => bindings,
		},
	};

	return { prisma, profiles, credentials, links, bindings };
}

function makeServices() {
	const {
		prisma,
		profiles: profileRows,
		credentials: credentialRows,
		links,
		bindings,
	} = makePrisma();
	const profiles = new PiProfileService(prisma as never);
	const credentials = new PiCredentialService(prisma as never, env, readKey);
	return { prisma, profiles, credentials, profileRows, credentialRows, links, bindings };
}

const profileInput = (credentialIds: string[] = ["c1"]) => ({
	name: "default",
	defaultModel: { provider: "anthropic", modelId: "claude-x" },
	allowedModels: [{ provider: "anthropic", modelId: "claude-x" }],
	defaultThinkingLevel: "medium" as const,
	credentialIds,
});

describe("PiCredentialService", () => {
	let s: ReturnType<typeof makeServices>;
	beforeEach(() => {
		s = makeServices();
	});

	it("创建凭据只返回安全字段，不含密文与明文", async () => {
		const info = await s.credentials.create({
			name: "k1",
			providerConfigId: "provider-anthropic",
			apiKey: "sk-live-abc",
		});
		const serialized = JSON.stringify(info);
		expect(serialized).not.toContain("sk-live");
		expect(serialized).not.toContain("ciphertext");
		expect(info.fingerprint).toHaveLength(8);
		expect(info.keyVersion).toBe(1);
	});

	it("密钥未配置时写入 fail closed（PI_CONFIG_UNAVAILABLE）", async () => {
		const withoutKey = new PiCredentialService(
			s.prisma as never,
			{} as NodeJS.ProcessEnv,
			readKey,
		);
		await expect(
			withoutKey.create({ name: "k", providerConfigId: "provider-p", apiKey: "x" }),
		).rejects.toMatchObject({ code: "PI_CONFIG_UNAVAILABLE" });
	});

	it("revoke 写 revokedAt 且不物理删除", async () => {
		const info = await s.credentials.create({
			name: "k1",
			providerConfigId: "provider-anthropic",
			apiKey: "sk-live-abc",
		});
		const revoked = await s.credentials.revoke(info.id);
		expect(revoked.revokedAt).not.toBeNull();
		expect(s.credentialRows).toHaveLength(1);
	});

	it("resolveSecrets 只解密未撤销且绑定到 Profile 的凭据", async () => {
		const created = await s.credentials.create({
			name: "k1",
			providerConfigId: "provider-anthropic",
			apiKey: "sk-live-abc",
		});
		const profile = await s.profiles.create(profileInput([created.id]));
		await expect(s.credentials.resolveSecrets(profile.id)).resolves.toEqual([
			{ providerId: "anthropic", apiKey: "sk-live-abc" },
		]);

		await s.credentials.revoke(created.id);
		await expect(s.credentials.resolveSecrets(profile.id)).resolves.toEqual([]);
	});
});

describe("PiProfileService", () => {
	let s: ReturnType<typeof makeServices>;
	beforeEach(() => {
		s = makeServices();
	});

	it("创建后按 allowedModels 与默认模型投影", async () => {
		const info = await s.profiles.create(profileInput());
		expect(info).toMatchObject({
			name: "default",
			enabled: true,
			defaultModel: { provider: "anthropic", modelId: "claude-x" },
			allowedModels: [{ provider: "anthropic", modelId: "claude-x" }],
			revision: 1,
		});
	});

	it("更新 Profile 字段递增 revision", async () => {
		const created = await s.profiles.create(profileInput());
		const updated = await s.profiles.update(created.id, {
			defaultModel: { provider: "anthropic", modelId: "claude-y" },
			allowedModels: [{ provider: "anthropic", modelId: "claude-y" }],
		});
		expect(updated.revision).toBe(created.revision + 1);
	});

	it("凭据轮换与撤销都会递增引用它的 Profile revision", async () => {
		const cred = await s.credentials.create({
			name: "k1",
			providerConfigId: "provider-anthropic",
			apiKey: "sk-a",
		});
		const profile = await s.profiles.create(profileInput([cred.id]));
		await s.credentials.update(cred.id, { apiKey: "sk-b" });
		const afterRotate = await s.profiles.get(profile.id);
		expect(afterRotate.revision).toBeGreaterThan(profile.revision);

		await s.credentials.revoke(cred.id);
		const afterRevoke = await s.profiles.get(profile.id);
		expect(afterRevoke.revision).toBeGreaterThan(afterRotate.revision);
	});

	it("删除仍被绑定的 Profile 被拒绝", async () => {
		const profile = await s.profiles.create(profileInput());
		await s.profiles.setBinding("client-1", profile.id);
		await expect(s.profiles.remove(profile.id)).rejects.toMatchObject({
			code: "PI_CONFIG_UNAVAILABLE",
		});
	});

	it("绑定到不存在的 Profile 被拒绝", async () => {
		await expect(
			s.profiles.setBinding("client-1", "missing"),
		).rejects.toMatchObject({ code: "PI_CONFIG_UNAVAILABLE" });
	});

	it("resolveBoundProfile 返回绑定 Profile；未绑定返回 null", async () => {
		const profile = await s.profiles.create(profileInput());
		await s.profiles.setBinding("client-1", profile.id);
		await expect(s.profiles.resolveBoundProfile("client-1")).resolves.toMatchObject(
			{ id: profile.id },
		);
		await expect(s.profiles.resolveBoundProfile("client-2")).resolves.toBeNull();
	});

	it("列表分页返回 PaginatedResult", async () => {
		await s.profiles.create(profileInput());
		const page = await s.profiles.list(1, 20);
		expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
	});
});

describe("PiProfileService 的工具策略与 Bundle 资源校验", () => {
	const baseInput = (extra: Record<string, unknown> = {}) => ({
		name: "default",
		defaultModel: { provider: "anthropic", modelId: "claude-x" },
		allowedModels: [{ provider: "anthropic", modelId: "claude-x" }],
		defaultThinkingLevel: "medium" as const,
		credentialIds: ["c1"],
		...extra,
	});

	it("启用 confirm 但未启用 vcp.tool-policy 时拒绝保存", async () => {
		const s = makeServices();
		await expect(
			s.profiles.create(
				baseInput({
					toolPolicy: { allow: [], confirm: ["bash"], deny: [] },
					enabledResourceIds: [],
				}),
			),
		).rejects.toMatchObject({ code: "PI_CONFIG_UNAVAILABLE" });
		await expect(
			s.profiles.create(
				baseInput({
					toolPolicy: { allow: [], confirm: ["bash"], deny: [] },
					enabledResourceIds: [],
				}),
			),
		).rejects.toThrow(/vcp\.tool-policy/);
	});

	it("策略与资源落库后可完整回读", async () => {
		const s = makeServices();
		const info = await s.profiles.create(
			baseInput({
				toolPolicy: { allow: ["read"], confirm: ["bash"], deny: ["write"] },
				enabledResourceIds: ["vcp.tool-policy"],
			}),
		);
		expect(info.toolPolicy).toEqual({
			allow: ["read"],
			confirm: ["bash"],
			deny: ["write"],
		});
		expect(info.enabledResourceIds).toEqual(["vcp.tool-policy"]);
	});

	it("空策略与无资源时两列存 NULL（读取回退为默认值）", async () => {
		const s = makeServices();
		const info = await s.profiles.create(
			baseInput({ toolPolicy: { allow: [], confirm: [], deny: [] } }),
		);
		expect(s.profileRows[0]?.toolPolicyJson).toBeNull();
		expect(s.profileRows[0]?.enabledResourceIds).toBeNull();
		expect(info.toolPolicy).toEqual({ allow: [], confirm: [], deny: [] });
		expect(info.enabledResourceIds).toEqual([]);
	});

	it("已有 Client 上报 Bundle 时拒绝未知资源 ID", async () => {
		const s = makeServices();
		const registry = new PiRuntimeRegistry();
		registry.setBundle("client-1", {
			protocolVersion: 1,
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resourceIds: ["vcp.tool-policy"],
		});
		const profiles = new PiProfileService(s.prisma as never, registry);
		await expect(
			profiles.create(baseInput({ enabledResourceIds: ["vcp.unknown"] })),
		).rejects.toThrow(/未知资源/);
		await expect(
			profiles.create(baseInput({ enabledResourceIds: ["vcp.tool-policy"] })),
		).resolves.toMatchObject({ enabledResourceIds: ["vcp.tool-policy"] });
	});

	it("尚无任何 Client 上报 Bundle 时允许保存（下发门控兜底）", async () => {
		const s = makeServices();
		const profiles = new PiProfileService(
			s.prisma as never,
			new PiRuntimeRegistry(),
		);
		await expect(
			profiles.create(
				baseInput({
					enabledResourceIds: ["vcp.tool-policy"],
					toolPolicy: { allow: [], confirm: ["bash"], deny: [] },
				}),
			),
		).resolves.toMatchObject({ enabledResourceIds: ["vcp.tool-policy"] });
	});

	it("更新时保留未提交的策略与资源", async () => {
		const s = makeServices();
		const created = await s.profiles.create(
			baseInput({
				enabledResourceIds: ["vcp.tool-policy"],
				toolPolicy: { allow: ["read"], confirm: [], deny: [] },
			}),
		);
		const updated = await s.profiles.update(created.id, { name: "renamed" });
		expect(updated.toolPolicy).toEqual({
			allow: ["read"],
			confirm: [],
			deny: [],
		});
		expect(updated.enabledResourceIds).toEqual(["vcp.tool-policy"]);
	});
});

describe("PiProfileService 的工具执行模式", () => {
	const baseInput = (extra: Record<string, unknown> = {}) => ({
		name: "default",
		defaultModel: { provider: "anthropic", modelId: "claude-x" },
		allowedModels: [{ provider: "anthropic", modelId: "claude-x" }],
		defaultThinkingLevel: "medium" as const,
		credentialIds: ["c1"],
		...extra,
	});

	it("省略时保守默认为 approval，显式模式落库并可回读", async () => {
		const s = makeServices();
		const omitted = await s.profiles.create(baseInput());
		expect(omitted.toolExecutionMode).toBe("approval");
		expect(s.profileRows[0]?.toolExecutionMode).toBe("approval");

		const explicit = await s.profiles.create(baseInput({ name: "auto", toolExecutionMode: "auto" }));
		expect(explicit.toolExecutionMode).toBe("auto");
		expect(s.profileRows[1]?.toolExecutionMode).toBe("auto");
	});

	it("更新模式递增 revision，并在未提交时保留原值", async () => {
		const s = makeServices();
		const created = await s.profiles.create(baseInput({ toolExecutionMode: "auto" }));
		const renamed = await s.profiles.update(created.id, { name: "renamed" });
		expect(renamed).toMatchObject({
			toolExecutionMode: "auto",
			revision: created.revision + 1,
		});
		const updated = await s.profiles.update(created.id, { toolExecutionMode: "yolo" });
		expect(updated).toMatchObject({
			toolExecutionMode: "yolo",
			revision: renamed.revision + 1,
		});
	});

	it("数据库中的非法模式 fail closed（PI_CONFIG_UNAVAILABLE）", async () => {
		const s = makeServices();
		const created = await s.profiles.create(baseInput());
		await s.profiles.setBinding("client-1", created.id);
		s.profileRows[0]!.toolExecutionMode = "unsafe";
		await expect(s.profiles.get(created.id)).rejects.toMatchObject({
			code: "PI_CONFIG_UNAVAILABLE",
		});
		// 绑定解析是下发路径的入口：损坏时也不得降级为可用 Profile
		await expect(s.profiles.resolveBoundProfile("client-1")).rejects.toMatchObject({
			code: "PI_CONFIG_UNAVAILABLE",
		});
	});
});
