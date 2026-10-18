import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service.js";
import { FeatureError, FeatureService } from "./feature.service.js";

interface RowLike {
	id: string;
	slug: string;
	name: string;
	summary: string;
	clientId: string;
	client: { name: string | null; hostname: string };
	scope: string;
	invoke: string;
	verify: string;
	inputs: string;
	output: string;
	notes: string;
	status: string;
	lastVerifiedAt: Date | null;
	lastVerifiedOk: boolean | null;
	lastVerifyEvidence: string | null;
	verifiedVia: string | null;
	sourceJobId: string | null;
	createdByName: string | null;
	createdVia: string | null;
	createdAt: Date;
	updatedAt: Date;
}

const invokeJson = JSON.stringify({
	kind: "http",
	method: "POST",
	url: "http://10.0.0.1:8188/prompt",
	timeoutSeconds: 60,
});
const verifyJson = JSON.stringify({
	kind: "http",
	method: "GET",
	url: "http://10.0.0.1:8188/system_stats",
	timeoutSeconds: 60,
});

const baseRow: RowLike = {
	id: "ft_1",
	slug: "comfyui-t2i",
	name: "ComfyUI 文生图",
	summary: "按工作流出图",
	clientId: "c1",
	client: { name: "silvermoon-box", hostname: "silvermoon-host" },
	scope: "generic",
	invoke: invokeJson,
	verify: verifyJson,
	inputs: "[]",
	output: "",
	notes: "",
	status: "draft",
	lastVerifiedAt: null,
	lastVerifiedOk: null,
	lastVerifyEvidence: null,
	verifiedVia: null,
	sourceJobId: null,
	createdByName: "Admin",
	createdVia: "cli",
	createdAt: new Date("2026-10-01T00:00:00.000Z"),
	updatedAt: new Date("2026-10-01T00:00:00.000Z"),
};

function makePrisma(options: {
	row?: RowLike | null;
	client?: unknown;
	createThrows?: unknown;
} = {}) {
	const row = options.row === undefined ? baseRow : options.row;
	const client =
		options.client === undefined
			? { id: "c1", name: "silvermoon-box", hostname: "h" }
			: options.client;
	const create = options.createThrows
		? vi.fn(async (_args: unknown) => {
				throw options.createThrows;
			})
		: vi.fn(async (_args: unknown) => row);
	const update = vi.fn(
		async (_args: { where: { id: string }; data: Record<string, unknown> }) =>
			row,
	);
	const prisma = {
		client: { findUnique: vi.fn(async (_args: unknown) => client) },
		feature: {
			create,
			update,
			findUnique: vi.fn(async (_args: unknown) => row),
			findMany: vi.fn(async (_args: unknown) => (row ? [row] : [])),
			count: vi.fn(async (_args: unknown) => (row ? 1 : 0)),
		},
	};
	return { prisma: prisma as unknown as PrismaService, update, create };
}

const validInput = {
	clientId: "c1",
	slug: "comfyui-t2i",
	name: "ComfyUI 文生图",
	summary: "按工作流出图",
	scope: "generic" as const,
	invoke: {
		kind: "http" as const,
		method: "POST" as const,
		url: "http://10.0.0.1:8188/prompt",
		timeoutSeconds: 60,
	},
	verify: {
		kind: "http" as const,
		method: "GET" as const,
		url: "http://10.0.0.1:8188/system_stats",
		timeoutSeconds: 60,
	},
	inputs: [],
	output: "",
	notes: "",
	sourceJobId: null,
};

describe("FeatureService", () => {
	it("验证成功把 draft 升为 active 并记录证据", async () => {
		const { prisma, update } = makePrisma();
		const service = new FeatureService(prisma);
		await service.reportVerification("ft_1", {
			ok: true,
			via: "cli",
			evidence: "HTTP 200",
		});
		expect(update.mock.calls[0][0].data.status).toBe("active");
		expect(update.mock.calls[0][0].data.lastVerifiedOk).toBe(true);
	});

	it("验证失败把 active 降为 draft", async () => {
		const { prisma, update } = makePrisma({
			row: { ...baseRow, status: "active" },
		});
		const service = new FeatureService(prisma);
		await service.reportVerification("ft_1", { ok: false, via: "cli" });
		expect(update.mock.calls[0][0].data.status).toBe("draft");
	});

	it("已退役条目不会被验证复活", async () => {
		const { prisma, update } = makePrisma({
			row: { ...baseRow, status: "retired" },
		});
		const service = new FeatureService(prisma);
		await service.reportVerification("ft_1", { ok: true, via: "cli" });
		expect(update.mock.calls[0][0].data.status).toBe("retired");
	});

	it("slug 冲突抛 409 FEATURE_SLUG_TAKEN", async () => {
		const { prisma } = makePrisma({ createThrows: { code: "P2002" } });
		const service = new FeatureService(prisma);
		await expect(service.create(validInput, null)).rejects.toMatchObject({
			code: "FEATURE_SLUG_TAKEN",
			statusCode: 409,
		});
	});

	it("存储契约损坏时投影为 draft 而不是抛错", async () => {
		const { prisma } = makePrisma({
			row: { ...baseRow, status: "active", invoke: "{broken" },
		});
		const service = new FeatureService(prisma);
		const info = await service.get("ft_1");
		expect(info.status).toBe("draft");
		expect(info.lastVerifyEvidence).toBe("存储内容损坏");
	});

	it("未知 Client 抛 404 FEATURE_CLIENT_UNKNOWN", async () => {
		const { prisma } = makePrisma({ client: null });
		const service = new FeatureService(prisma);
		await expect(service.create(validInput, null)).rejects.toBeInstanceOf(
			FeatureError,
		);
		await expect(service.create(validInput, null)).rejects.toMatchObject({
			code: "FEATURE_CLIENT_UNKNOWN",
			statusCode: 404,
		});
	});
});
