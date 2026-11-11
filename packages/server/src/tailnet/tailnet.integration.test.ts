/**
 * Tailnet 管理端到端集成测试（ADR-0062）。
 *
 * 使用独立临时 SQLite 与内存 fake scheduler，不启动网络、不连接开发库。
 * 重点验证：socket/任务所有权、密钥一次性交付、并发预留、终态收尾。
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/client/index.js";
import type { TailnetJobPayload, TailnetSnapshot } from "@vcpdeck/shared";
import { JobService } from "../job/job.service.js";
import { TAILNET_KEY_FILE_ENV } from "./tailnet-crypto.js";
import { TailnetKeyService } from "./tailnet-key.service.js";
import { TailnetService } from "./tailnet.service.js";

const SERVER_ROOT = process.cwd();
const PRISMA_CLI = join(SERVER_ROOT, "node_modules", "prisma", "build", "index.js");
const SCHEMA_PATH = join(SERVER_ROOT, "prisma", "schema.prisma");
const AUTH_KEY = "tskey-auth-kIntegration-0123456789abcdef";

let dir: string;
let prisma: PrismaClient;
let keys: TailnetKeyService;
let service: TailnetService;
let jobs: JobService;

function toUrl(path: string): string {
	return `file:${path.replace(/\\/g, "/")}`;
}

const SNAPSHOT: TailnetSnapshot = {
	installed: "yes",
	version: "1.104.5",
	service: "running",
	backend: "needs-login",
	nodeName: null,
	ipv4: [],
	ipv6: [],
	observedAt: new Date().toISOString(),
	errorCode: null,
};

async function seedClient(
	id: string,
	socketId: string,
	options: {
		online?: boolean;
		capabilities?: string[];
		tailnetCapability?: boolean;
	} = {},
): Promise<void> {
	const capabilities = options.capabilities ?? ["exec", "tailnet.manage"];
	const details =
		options.tailnetCapability === false
			? {}
			: { tailnet: { protocolVersion: 1 } };
	await prisma.client.create({
		data: {
			id,
			hostname: id,
			name: id,
			os: "linux",
			cpuModel: "test",
			totalMemMB: 1024,
			clientVersion: "0.0.0-test",
			capabilities: JSON.stringify(capabilities),
			capabilityDetails: JSON.stringify(details),
			annotations: "{}",
			disks: "[]",
			online: options.online ?? true,
			socketId,
			connectedAt: new Date(),
		},
	});
}

async function seedEnsureJob(
	jobId: string,
	clientId: string,
	credentialId: string,
	status = "running",
): Promise<void> {
	const payload: TailnetJobPayload = {
		action: "ensure",
		credentialId,
		installIfMissing: true,
	};
	await prisma.job.create({
		data: {
			id: jobId,
			clientId,
			type: "tailnet.manage",
			status,
			payload: JSON.stringify(payload),
			startedAt: status === "running" ? new Date() : null,
			createdByName: "tester",
			createdVia: "cli",
		},
	});
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "vcp-tailnet-it-"));
	const dbUrl = toUrl(join(dir, "test.db"));
	execFileSync(
		process.execPath,
		[PRISMA_CLI, "db", "push", "--schema", SCHEMA_PATH, "--url", dbUrl],
		{ cwd: SERVER_ROOT, stdio: "pipe" },
	);
	prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: dbUrl }, {}) });
	await prisma.$connect();
	const keyFile = join(dir, "tailnet.key");
	writeFileSync(keyFile, randomBytes(32).toString("base64"));

	keys = new TailnetKeyService(prisma, { [TAILNET_KEY_FILE_ENV]: keyFile });
	service = new TailnetService(prisma as never, keys);
	jobs = new JobService(
		prisma as never,
		{
			tryDispatch: async () => null,
			onFinished: async () => null,
		} as never,
		{} as never,
		{} as never,
		dir,
		undefined,
		keys,
	);
}, 60_000);

afterAll(async () => {
	await prisma?.$disconnect();
	if (dir) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			// Windows 上 libsql 句柄由系统临时目录清理兜底。
		}
	}
});

beforeEach(async () => {
	await prisma.tailnetClientOperation.deleteMany();
	await prisma.tailnetCredential.deleteMany();
	await prisma.job.deleteMany();
	await prisma.client.deleteMany();
});

describe("authorizeSecret 所有权与一次性交付", () => {
	it("异 socket 请求他人 Job 被拒绝且不解密", async () => {
		await seedClient("c1", "socket-c1");
		await seedClient("c2", "socket-c2");
		const key = await keys.importKey({
			name: "k1",
			authKey: AUTH_KEY,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		await seedEnsureJob("job-c1", "c1", key.id);
		await prisma.tailnetClientOperation.create({
			data: { clientId: "c1", jobId: "job-c1" },
		});
		await keys.reserve(prisma as never, key.id, "job-c1");
		const issueSpy = vi.spyOn(keys, "issue");

		await expect(
			service.authorizeSecret("socket-c2", {
				protocolVersion: 1,
				jobId: "job-c1",
				requestId: "request-1",
			}),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_MISMATCH" });
		expect(issueSpy).not.toHaveBeenCalled();
		issueSpy.mockRestore();
	});

	it("旧 socket 请求同一 Job 被拒绝", async () => {
		await seedClient("c1", "socket-new");
		const key = await keys.importKey({
			name: "k1",
			authKey: AUTH_KEY,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		await seedEnsureJob("job-c1", "c1", key.id);
		await prisma.tailnetClientOperation.create({
			data: { clientId: "c1", jobId: "job-c1" },
		});
		await keys.reserve(prisma as never, key.id, "job-c1");

		await expect(
			service.authorizeSecret("socket-old", {
				protocolVersion: 1,
				jobId: "job-c1",
				requestId: "request-1",
			}),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_MISMATCH" });
	});

	it("当前 socket 只交付一次，并返回短时窗口", async () => {
		await seedClient("c1", "socket-c1");
		const key = await keys.importKey({
			name: "k1",
			authKey: AUTH_KEY,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		await seedEnsureJob("job-c1", "c1", key.id);
		await prisma.tailnetClientOperation.create({
			data: { clientId: "c1", jobId: "job-c1" },
		});
		await keys.reserve(prisma as never, key.id, "job-c1");

		const before = Date.now();
		const response = await service.authorizeSecret("socket-c1", {
			protocolVersion: 1,
			jobId: "job-c1",
			requestId: "request-1",
		});
		expect(response.authKey).toBe(AUTH_KEY);
		expect(response.jobId).toBe("job-c1");
		expect(response.requestId).toBe("request-1");
		const expiresAt = Date.parse(response.expiresAt);
		expect(expiresAt).toBeGreaterThan(before + 20_000);
		expect(expiresAt).toBeLessThan(before + 40_000);

		await expect(
			service.authorizeSecret("socket-c1", {
				protocolVersion: 1,
				jobId: "job-c1",
				requestId: "request-2",
			}),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_MISMATCH" });
	});

	it("queued、已取消、action=inspect 与能力缺失都拒绝", async () => {
		await seedClient("c1", "socket-c1");
		await seedClient("c3", "socket-c3", { tailnetCapability: false });
		const key = await keys.importKey({
			name: "k1",
			authKey: AUTH_KEY,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});

		await seedEnsureJob("job-queued", "c1", key.id, "pending");
		await prisma.tailnetClientOperation.create({
			data: { clientId: "c1", jobId: "job-queued" },
		});
		await expect(
			service.authorizeSecret("socket-c1", {
				protocolVersion: 1,
				jobId: "job-queued",
				requestId: "r1",
			}),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_MISMATCH" });

		await prisma.tailnetClientOperation.deleteMany();
		await seedEnsureJob("job-inspect", "c1", key.id, "running");
		await prisma.job.update({
			where: { id: "job-inspect" },
			data: { payload: JSON.stringify({ action: "inspect" }) },
		});
		await prisma.tailnetClientOperation.create({
			data: { clientId: "c1", jobId: "job-inspect" },
		});
		await expect(
			service.authorizeSecret("socket-c1", {
				protocolVersion: 1,
				jobId: "job-inspect",
				requestId: "r2",
			}),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_MISMATCH" });

		await prisma.tailnetClientOperation.deleteMany();
		await seedEnsureJob("job-c3", "c3", key.id, "running");
		await prisma.tailnetClientOperation.create({
			data: { clientId: "c3", jobId: "job-c3" },
		});
		await expect(
			service.authorizeSecret("socket-c3", {
				protocolVersion: 1,
				jobId: "job-c3",
				requestId: "r3",
			}),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_MISMATCH" });
	});
});

describe("Job 创建、并发预留与终态收尾", () => {
	it("同机第二个 Tailnet 管理任务被 OPERATION_BUSY 拒绝", async () => {
		await seedClient("c1", "socket-c1");
		const k1 = await keys.importKey({
			name: "k1",
			authKey: AUTH_KEY,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		const k2 = await keys.importKey({
			name: "k2",
			authKey: `${AUTH_KEY}-2`,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		await jobs.create(
			{
				clientId: "c1",
				type: "tailnet.manage",
				payload: { action: "ensure", credentialId: k1.id, installIfMissing: true },
			},
			{ identityId: null, displayName: "tester", source: "cli", requestId: "a" } as never,
		);
		await expect(
			jobs.create(
				{
					clientId: "c1",
					type: "tailnet.manage",
					payload: { action: "ensure", credentialId: k2.id, installIfMissing: true },
				},
				{ identityId: null, displayName: "tester", source: "cli", requestId: "b" } as never,
			),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_BUSY" });
	});

	it("跨机并发使用同一凭据只有一个预留成功", async () => {
		await seedClient("c1", "socket-c1");
		await seedClient("c2", "socket-c2");
		const key = await keys.importKey({
			name: "shared",
			authKey: AUTH_KEY,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		const actor = {
			identityId: null,
			displayName: "tester",
			source: "cli",
			requestId: "a",
		} as never;
		const payload = { action: "ensure", credentialId: key.id, installIfMissing: true };
		const results = await Promise.allSettled([
			jobs.create({ clientId: "c1", type: "tailnet.manage", payload }, actor),
			jobs.create({ clientId: "c2", type: "tailnet.manage", payload }, actor),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((r) => r.status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: { code: "TAILNET_KEY_BUSY" },
		});
	});

	it("普通入口夹带 authKey 被拒绝且不创建 Job", async () => {
		await seedClient("c1", "socket-c1");
		await expect(
			jobs.create(
				{
					clientId: "c1",
					type: "tailnet.manage",
					payload: {
						action: "ensure",
						credentialId: "k1",
						installIfMissing: true,
						authKey: AUTH_KEY,
					},
				},
				{ identityId: null, displayName: "tester", source: "api", requestId: "a" } as never,
			),
		).rejects.toMatchObject({ code: "INVALID_JOB_PAYLOAD" });
		expect(await prisma.job.count()).toBe(0);
	});

	it("完成后凭据 spent、占位删除；取消且未发正文时回到 available", async () => {
		await seedClient("c1", "socket-c1");
		await seedClient("c2", "socket-c2");
		const spent = await keys.importKey({
			name: "spent",
			authKey: AUTH_KEY,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		await seedEnsureJob("job-done", "c1", spent.id);
		await prisma.tailnetClientOperation.create({
			data: { clientId: "c1", jobId: "job-done" },
		});
		await keys.reserve(prisma as never, spent.id, "job-done");
		await service.authorizeSecret("socket-c1", {
			protocolVersion: 1,
			jobId: "job-done",
			requestId: "r1",
		});
		await jobs.markDone("job-done", "tailnet.manage", {
			stage: "joined",
			snapshot: SNAPSHOT,
		});
		const spentRow = await prisma.tailnetCredential.findUnique({ where: { id: spent.id } });
		expect(spentRow?.use).toBe("spent");
		expect(spentRow?.reservedJobId).toBeNull();
		expect(await prisma.tailnetClientOperation.count()).toBe(0);

		const unused = await keys.importKey({
			name: "unused",
			authKey: `${AUTH_KEY}-u`,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		await seedEnsureJob("job-cancel", "c2", unused.id);
		await prisma.tailnetClientOperation.create({
			data: { clientId: "c2", jobId: "job-cancel" },
		});
		await keys.reserve(prisma as never, unused.id, "job-cancel");
		await jobs.markCancelled("job-cancel");
		const unusedRow = await prisma.tailnetCredential.findUnique({ where: { id: unused.id } });
		expect(unusedRow?.use).toBe("available");
		expect(unusedRow?.reservedJobId).toBeNull();
		expect(await prisma.tailnetClientOperation.count()).toBe(0);
	});
});

describe("状态与摘要持久化", () => {
	it("离线客户端仍返回历史摘要，正文不含密文", async () => {
		await seedClient("c1", "socket-c1", { online: false });
		const key = await keys.importKey({
			name: "k1",
			authKey: AUTH_KEY,
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		await service.recordSnapshot("c1", SNAPSHOT);
		const status = await service.getStatus("c1");
		expect(status.online).toBe(false);
		expect(status.supported).toBe(true);
		expect(status.snapshot).toMatchObject({ installed: "yes", backend: "needs-login" });
		const json = JSON.stringify(status);
		expect(json).not.toContain(AUTH_KEY);
		expect(json).not.toContain("ciphertext");
		expect((await prisma.tailnetCredential.findUnique({ where: { id: key.id } }))?.ciphertext)
			.not.toContain(AUTH_KEY);
	});
});
