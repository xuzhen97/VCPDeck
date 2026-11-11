/**
 * Tailnet 凭据服务单测（ADR-0062）。
 *
 * 使用独立临时 SQLite（`prisma db push --skip-generate` 建表），
 * 绝不指向开发库；用例结束后删除临时目录。
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/client/index.js";
import { TAILNET_KEY_FILE_ENV } from "./tailnet-crypto.js";
import { TailnetKeyService } from "./tailnet-key.service.js";

const SERVER_ROOT = process.cwd();
const PRISMA_CLI = join(SERVER_ROOT, "node_modules", "prisma", "build", "index.js");
const SCHEMA_PATH = join(SERVER_ROOT, "prisma", "schema.prisma");

const AUTH_KEY = "tskey-auth-kUnitTest-0123456789abcdef";

let dir: string;
let prisma: PrismaClient;
let service: TailnetKeyService;
let keyFile: string;

function toUrl(path: string): string {
	return `file:${path.replace(/\\/g, "/")}`;
}

function expectCode(error: unknown, code: string): void {
	expect(error).toMatchObject({ code });
}

function input(overrides: Record<string, unknown> = {}) {
	return {
		name: "测试凭据",
		authKey: AUTH_KEY,
		declaredReuse: "single" as const,
		declaredExpiresAt: null,
		...overrides,
	};
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "vcp-tailnet-svc-"));
	const dbUrl = toUrl(join(dir, "test.db"));
	execFileSync(
		process.execPath,
		[PRISMA_CLI, "db", "push", "--schema", SCHEMA_PATH, "--url", dbUrl],
		{
			cwd: SERVER_ROOT,
			stdio: "pipe",
		},
	);
	prisma = new PrismaClient({
		adapter: new PrismaLibSql({ url: dbUrl }, {}),
	});
	await prisma.$connect();
	keyFile = join(dir, "tailnet.key");
	writeFileSync(keyFile, randomBytes(32).toString("base64"));
	service = new TailnetKeyService(prisma, { [TAILNET_KEY_FILE_ENV]: keyFile });
}, 60_000);

afterAll(async () => {
	await prisma?.$disconnect();
	// Windows 上 libsql 句柄要等进程退出才释放；删不掉就留给系统临时目录清理。
	if (dir) {
		try {
			rmSync(dir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch {
			// 临时目录不在仓库内，清理失败不影响测试结论。
		}
	}
});

beforeEach(async () => {
	await prisma.tailnetClientOperation.deleteMany();
	await prisma.tailnetCredential.deleteMany();
});

describe("导入与列表", () => {
	it("只返回元信息，数据库只存密文", async () => {
		const info = await service.importKey(input());
		expect(info.name).toBe("测试凭据");
		expect(info.declaredReuse).toBe("single");
		expect(info.use).toBe("available");
		expect(JSON.stringify(info)).not.toContain(AUTH_KEY);
		const row = await prisma.tailnetCredential.findUnique({
			where: { id: info.id },
		});
		expect(row?.ciphertext).toBeTruthy();
		expect(row?.ciphertext).not.toContain(AUTH_KEY);
		expect(row?.ciphertext).not.toBe(AUTH_KEY);
	});

	it("分页列表返回 PaginatedResult，且不泄露密文", async () => {
		for (const name of ["a", "b", "c"]) {
			await service.importKey(input({ name }));
		}
		const page = await service.listKeys(2, 2);
		expect(page.total).toBe(3);
		expect(page.page).toBe(2);
		expect(page.pageSize).toBe(2);
		expect(page.totalPages).toBe(2);
		expect(page.data).toHaveLength(1);
		const json = JSON.stringify(page);
		expect(json).not.toContain("ciphertext");
		expect(json).not.toContain(AUTH_KEY);
	});

	it("根密钥缺失时导入 fail closed，但已有元数据仍可读", async () => {
		const info = await service.importKey(input());
		const noKey = new TailnetKeyService(prisma, {});
		await expect(noKey.importKey(input())).rejects.toMatchObject({
			code: "TAILNET_KEY_UNAVAILABLE",
		});
		const page = await noKey.listKeys(1, 10);
		expect(page.data.map((row) => row.id)).toContain(info.id);
	});
});

describe("预留与交付", () => {
	it("并发预留同一凭据只有一个成功", async () => {
		const info = await service.importKey(input());
		const results = await Promise.allSettled([
			service.reserve(prisma, info.id, "job-a"),
			service.reserve(prisma, info.id, "job-b"),
		]);
		const fulfilled = results.filter((item) => item.status === "fulfilled");
		expect(fulfilled).toHaveLength(1);
		const rejected = results.find((item) => item.status === "rejected");
		expectCode((rejected as PromiseRejectedResult).reason, "TAILNET_KEY_BUSY");
	});

	it("同一 jobId 重复预留幂等", async () => {
		const info = await service.importKey(input());
		await service.reserve(prisma, info.id, "job-a");
		await expect(
			service.reserve(prisma, info.id, "job-a"),
		).resolves.toBeUndefined();
	});

	it("交付返回明文；single 交付后即作废且不可重复下发", async () => {
		const info = await service.importKey(input());
		await service.reserve(prisma, info.id, "job-a");
		await expect(service.issue(info.id, "job-a")).resolves.toBe(AUTH_KEY);
		const row = await prisma.tailnetCredential.findUnique({
			where: { id: info.id },
		});
		expect(row?.use).toBe("spent");
		expect(row?.issuedAt).toBeTruthy();
		await expect(service.issue(info.id, "job-a")).rejects.toMatchObject({
			code: "TAILNET_KEY_BUSY",
		});
	});

	it("未交付时取消预留释放为 available", async () => {
		const info = await service.importKey(input());
		await service.reserve(prisma, info.id, "job-a");
		await service.settle(prisma, "job-a", "unused");
		const row = await prisma.tailnetCredential.findUnique({
			where: { id: info.id },
		});
		expect(row?.use).toBe("available");
		expect(row?.reservedJobId).toBeNull();
	});

	it("交付后结果不明保持 uncertain", async () => {
		const info = await service.importKey(input());
		await service.reserve(prisma, info.id, "job-a");
		await service.issue(info.id, "job-a");
		await service.settle(prisma, "job-a", "uncertain");
		const row = await prisma.tailnetCredential.findUnique({
			where: { id: info.id },
		});
		expect(row?.use).toBe("uncertain");
		expect(row?.reservedJobId).toBeNull();
	});

	it("reusable 凭据确认消耗后回到 available", async () => {
		const info = await service.importKey(input({ declaredReuse: "reusable" }));
		await service.reserve(prisma, info.id, "job-a");
		await service.issue(info.id, "job-a");
		await service.settle(prisma, "job-a", "consumed");
		const row = await prisma.tailnetCredential.findUnique({
			where: { id: info.id },
		});
		expect(row?.use).toBe("available");
		expect(row?.reservedJobId).toBeNull();
	});
});

describe("删除", () => {
	it("reserved 凭据拒绝删除（409）", async () => {
		const info = await service.importKey(input());
		await service.reserve(prisma, info.id, "job-a");
		await expect(service.deleteKey(info.id)).rejects.toMatchObject({
			code: "TAILNET_KEY_BUSY",
			statusCode: 409,
		});
	});

	it("available 凭据删除成功", async () => {
		const info = await service.importKey(input());
		await expect(service.deleteKey(info.id)).resolves.toEqual({
			deleted: true,
		});
		expect(
			await prisma.tailnetCredential.findUnique({ where: { id: info.id } }),
		).toBeNull();
	});

	it("不存在的凭据返回 NOT_FOUND", async () => {
		await expect(service.deleteKey("missing")).rejects.toMatchObject({
			code: "NOT_FOUND",
			statusCode: 404,
		});
	});
});
