import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
	TunnelConfigError,
	TunnelConfigService,
} from "./tunnel-config.service.js";

// 将 shared secret 文件读取 mock 化，避免依赖真实文件系统路径。
vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { readFile } from "node:fs/promises";

function configRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "default",
		stunUrls: '["stun:turn.example.com:3478"]',
		turnUrls: '["turn:turn.example.com:3478?transport=udp"]',
		realm: "turn.example.com",
		updatedAt: new Date("2026-09-11T00:00:00.000Z"),
		...overrides,
	};
}

function service() {
	const findUnique = vi.fn(async () => configRow());
	const prisma = {
		tunnelConfig: {
			findUnique,
			create: vi.fn(async () => configRow()),
		},
		$executeRawUnsafe: vi.fn(async () => 1),
	};
	return { service: new TunnelConfigService(prisma as never), findUnique, prisma };
}

describe("TunnelConfigService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.VCPDECK_TURN_SECRET_FILE = "/tmp/vcpdeck-turn-secret";
	});

	it("按 coturn TURN REST 算法签发 24h 凭据且 get() 不返回 shared secret", async () => {
		const now = new Date("2026-09-11T00:00:00.000Z");
		vi.mocked(readFile).mockResolvedValue("shared-secret\n");
		const { service: svc } = service();

		const issued = await svc.issueIceServers("tn_123", now);
		const username = `${Math.floor(now.getTime() / 1000) + 86400}:tn_123`;
		const expected = createHmac("sha1", "shared-secret").update(username).digest("base64");
		expect(issued).toContainEqual({
			urls: ["turn:turn.example.com:3478?transport=udp"],
			username,
			credential: expected,
		});
		// STUN 无凭据。
		expect(issued).toContainEqual({ urls: ["stun:turn.example.com:3478"] });

		const info = await svc.get();
		expect(info.turnSecretConfigured).toBe(true);
		expect(JSON.stringify(info)).not.toContain("shared-secret");
	});

	it.each(["", "\n"])("空 TURN secret 时 issueIceServers 以稳定错误失败 %p", async (secret) => {
		vi.mocked(readFile).mockResolvedValue(secret);
		const { service: svc } = service();
		await expect(svc.issueIceServers("tn_123")).rejects.toMatchObject({
			code: "TUNNEL_TURN_NOT_CONFIGURED",
		});
	});

	it("secret 文件缺失（读取抛错）时 issueIceServers 失败，get() 显示未配置", async () => {
		vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
		const { service: svc } = service();
		await expect(svc.issueIceServers("tn_123")).rejects.toBeInstanceOf(TunnelConfigError);
		const info = await svc.get();
		expect(info.turnSecretConfigured).toBe(false);
	});

	it("env 未设置 VCPDECK_TURN_SECRET_FILE 时视为未配置", async () => {
		delete process.env.VCPDECK_TURN_SECRET_FILE;
		const { service: svc } = service();
		expect(await svc.get()).toMatchObject({ turnSecretConfigured: false });
	});

	it("配置 JSON 损坏时 get() 回退为空数组而非抛出", async () => {
		vi.mocked(readFile).mockResolvedValue("shared-secret");
		const { service: svc, findUnique } = service();
		findUnique.mockResolvedValue(configRow({ stunUrls: "{not-json", turnUrls: "[]" }));
		const info = await svc.get();
		expect(info.stunUrls).toEqual([]);
	});

	it("update 拒绝 secret 字段并持久化非秘密配置", async () => {
		vi.mocked(readFile).mockResolvedValue("shared-secret");
		const { service: svc } = service();
		await expect(
			svc.update({
				stunUrls: ["stun:turn.example.com:3478"],
				turnUrls: [],
				realm: "turn.example.com",
				secret: "should-reject",
			} as never),
		).rejects.toThrow();
		const saved = await svc.update({
			stunUrls: ["stun:turn.example.com:3478"],
			turnUrls: ["turn:turn.example.com:3478?transport=udp"],
			realm: "turn.example.com",
		});
		expect(saved.realm).toBe("turn.example.com");
	});
});
