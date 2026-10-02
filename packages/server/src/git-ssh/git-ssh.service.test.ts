import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSshCommand } from "@vcpdeck/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateGitSshEd25519KeyPair, gitSshCipherFromKey } from "./git-ssh-crypto.js";
import { GitSshService } from "./git-ssh.service.js";

const ROOT_KEY = randomBytes(32).toString("base64");

const tempDirs: string[] = [];

/** 每个用例一个临时 app-dir：避免测试污染真实的 packages/server/data。 */
async function tempAppDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vcp-gitssh-svc-"));
	tempDirs.push(dir);
	return dir;
}

function managedKeyFile(appDir: string): string {
	return join(appDir, "data", "git-ssh", "root.key");
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		await rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

const env = { VCPDECK_GIT_SSH_KEY_FILE: "/k" };
const readFileImpl = async () => `${ROOT_KEY}\n`;

interface KeyRow {
	id: string;
	version: number;
	publicKey: string;
	fingerprint: string;
	ciphertext: string;
	keyVersion: number;
}

interface TargetRow {
	clientId: string;
	desiredVersion: number | null;
	observedVersion: number | null;
	state: string;
	reasonCode: string | null;
	operationId: string | null;
	lastSentVersion: number | null;
}

/** 内存 Prisma 假实现：状态机的对账语义比逐个 stub 断言更可靠。 */
function makePrisma(seed: { keys?: KeyRow[]; targets?: TargetRow[] } = {}) {
	const keys: KeyRow[] = [...(seed.keys ?? [])];
	const targets: TargetRow[] = [...(seed.targets ?? [])];
	const prisma = {
		keys,
		targets,
		gitSshKey: {
			findFirst: vi.fn(
				async () => [...keys].sort((a, b) => b.version - a.version)[0] ?? null,
			),
			findUnique: vi.fn(
				async ({ where }: { where: { version: number } }) =>
					keys.find((row) => row.version === where.version) ?? null,
			),
			create: vi.fn(async ({ data }: { data: KeyRow }) => {
				keys.push({ ...data });
				return data;
			}),
		},
		gitSshTarget: {
			findMany: vi.fn(async () =>
				[...targets].sort((a, b) => a.clientId.localeCompare(b.clientId)),
			),
			findUnique: vi.fn(
				async ({ where }: { where: { clientId: string } }) =>
					targets.find((row) => row.clientId === where.clientId) ?? null,
			),
			upsert: vi.fn(
				async ({
					where,
					create,
					update,
				}: {
					where: { clientId: string };
					create: TargetRow;
					update: Partial<TargetRow>;
				}) => {
					const found = targets.find((row) => row.clientId === where.clientId);
					if (found) {
						Object.assign(found, update);
						return found;
					}
					const row: TargetRow = { ...create };
					targets.push(row);
					return row;
				},
			),
			update: vi.fn(
				async ({
					where,
					data,
				}: {
					where: { clientId: string };
					data: Partial<TargetRow>;
				}) => {
					const found = targets.find((row) => row.clientId === where.clientId);
					if (!found) throw new Error(`target ${where.clientId} missing`);
					Object.assign(found, data);
					return found;
				},
			),
			deleteMany: vi.fn(async () => ({ count: 0 })),
		},
	};
	return prisma;
}

function makeService(
	prisma: ReturnType<typeof makePrisma>,
	options: {
		env?: NodeJS.ProcessEnv;
		readFileImpl?: (path: string) => Promise<string>;
	} = {},
) {
	let generated: ReturnType<typeof generateGitSshEd25519KeyPair> | null = null;
	const service = new GitSshService(
		prisma as never,
		options.env ?? env,
		options.readFileImpl ?? readFileImpl,
		() => {
			generated = generateGitSshEd25519KeyPair();
			return generated;
		},
	);
	const sent: Array<{ socketId: string; command: GitSshCommand }> = [];
	service.bindSender((socketId, command) => {
		sent.push({ socketId, command });
	});
	return {
		service,
		sent,
		generatedPair: () => generated,
	};
}

function target(overrides: Partial<TargetRow> = {}): TargetRow {
	return {
		clientId: "client-a",
		desiredVersion: null,
		observedVersion: null,
		state: "pending",
		reasonCode: null,
		operationId: null,
		lastSentVersion: null,
		...overrides,
	};
}

describe("GitSshService 密钥生成", () => {
	it("加密保存私钥、只返回公钥与指纹", async () => {
		const prisma = makePrisma();
		const { service, generatedPair } = makeService(prisma);
		const info = await service.generate();

		expect(info.version).toBe(1);
		expect(info.publicKey).toBe(generatedPair()!.publicKey);
		expect(info.fingerprint).toMatch(/^SHA256:/);
		expect(JSON.stringify(info)).not.toContain("BEGIN OPENSSH PRIVATE KEY");

		const row = prisma.keys[0]!;
		expect(row.ciphertext).not.toContain("OPENSSH");
		expect(row.keyVersion).toBe(1);
		// 密文必须能解回生成时的私钥（Server 是唯一可解密方）。
		const { loadGitSshKeyCipher } = await import("./git-ssh-crypto.js");
		const cipher = (await loadGitSshKeyCipher(env, readFileImpl))!;
		expect(cipher.decrypt(row.ciphertext, row.keyVersion)).toBe(
			generatedPair()!.privateKey,
		);
	});

	it("受管根密钥损坏时生成 fail closed，且不覆盖既有文件", async () => {
		const appDir = await tempAppDir();
		const file = managedKeyFile(appDir);
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(appDir, "data", "git-ssh"), { recursive: true });
		await writeFile(file, "broken\n");
		const prisma = makePrisma();
		await expect(
			new GitSshService(prisma as never, { VCPDECK_APP_DIR: appDir }).generate(),
		).rejects.toMatchObject({ code: "GIT_SSH_KEY_UNAVAILABLE" });
		expect(prisma.keys).toHaveLength(0);
		expect(await readFile(file, "utf8")).toBe("broken\n");
	});

	it("无任何配置时首次生成自动创建受管根密钥，重启后可继续解密并换代", async () => {
		const appDir = await tempAppDir();
		const env = { VCPDECK_APP_DIR: appDir };
		const prisma = makePrisma();

		const first = await new GitSshService(prisma as never, env).generate();
		expect(first.version).toBe(1);
		expect(prisma.keys).toHaveLength(1);

		const raw = await readFile(managedKeyFile(appDir), "utf8");
		const key = Buffer.from(raw.trim(), "base64");
		expect(key).toHaveLength(32);
		// 重启（新实例、新 keyGenerator）后仍能用同一根密钥解开既有密文。
		const cipher = gitSshCipherFromKey(key);
		expect(cipher.decrypt(prisma.keys[0]!.ciphertext, 1)).toContain(
			"BEGIN OPENSSH PRIVATE KEY",
		);

		const second = await new GitSshService(prisma as never, env).generate();
		expect(second.version).toBe(2);
		expect(prisma.keys.map((row) => row.version)).toEqual([1, 2]);
	});

	it("已有密文但根密钥文件丢失时拒绝生成，且不重新创建", async () => {
		const appDir = await tempAppDir();
		const env = { VCPDECK_APP_DIR: appDir };
		const prisma = makePrisma();
		await new GitSshService(prisma as never, env).generate();
		await rm(managedKeyFile(appDir));

		await expect(
			new GitSshService(prisma as never, env).generate(),
		).rejects.toMatchObject({ code: "GIT_SSH_KEY_UNAVAILABLE" });
		expect(prisma.keys).toHaveLength(1);
		// 绝不静默换一把根密钥：既有私钥会因此永久无法解密。
		await expect(readFile(managedKeyFile(appDir), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("根密钥与既有密文不匹配时拒绝换代", async () => {
		const appDir = await tempAppDir();
		const env = { VCPDECK_APP_DIR: appDir };
		const prisma = makePrisma();
		await new GitSshService(prisma as never, env).generate();
		// 模拟“数据库回退到旧快照、文件来自另一安装”的错绑场景。
		await writeFile(
			managedKeyFile(appDir),
			`${randomBytes(32).toString("base64")}\n`,
		);

		await expect(
			new GitSshService(prisma as never, env).generate(),
		).rejects.toMatchObject({ code: "GIT_SSH_KEY_UNAVAILABLE" });
		expect(prisma.keys).toHaveLength(1);
	});

	it("显式配置优先，不可读时 fail closed 且不回退到受管路径", async () => {
		const appDir = await tempAppDir();
		const explicit = join(appDir, "explicit.key");
		const prisma = makePrisma();
		await expect(
			new GitSshService(prisma as never, {
				VCPDECK_APP_DIR: appDir,
				VCPDECK_GIT_SSH_KEY_FILE: explicit,
			}).generate(),
		).rejects.toMatchObject({ code: "GIT_SSH_KEY_UNAVAILABLE" });
		await expect(readFile(explicit, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(managedKeyFile(appDir), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(prisma.keys).toHaveLength(0);
	});

	it("只读的状态查询不创建根密钥", async () => {
		const appDir = await tempAppDir();
		const prisma = makePrisma();
		const service = new GitSshService(prisma as never, {
			VCPDECK_APP_DIR: appDir,
		});
		expect(await service.getPublicInfo()).toBeNull();
		expect(await service.status()).toEqual({ key: null, targets: [] });
		await expect(readFile(managedKeyFile(appDir), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("根密钥缺失时注册、重连与下发都不创建根密钥，也不下发", async () => {
		const appDir = await tempAppDir();
		const prisma = makePrisma({
			targets: [target({ clientId: "client-a", desiredVersion: 1 })],
		});
		const service = new GitSshService(prisma as never, {
			VCPDECK_APP_DIR: appDir,
		});
		const sent: Array<{ socketId: string; command: GitSshCommand }> = [];
		service.bindSender((socketId, command) => {
			sent.push({ socketId, command });
		});

		await service.onRegistered("client-a", "socket-a", {
			available: true,
			protocolVersion: 1,
		});
		await service.onDisconnected("client-a", "socket-a");
		await service.onRegistered("client-a", "socket-b", {
			available: true,
			protocolVersion: 1,
		});

		expect(sent).toHaveLength(0);
		await expect(readFile(managedKeyFile(appDir), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("再次生成递增版本并保留历史行（可靠轮换）", async () => {
		const prisma = makePrisma();
		const { service } = makeService(prisma);
		await service.generate();
		const second = await service.generate();
		expect(second.version).toBe(2);
		expect(prisma.keys.map((row) => row.version)).toEqual([1, 2]);
		expect(prisma.keys[0]!.ciphertext).not.toBe(prisma.keys[1]!.ciphertext);
	});

	it("生成后把已选机改为新版待下发，已取消选机的保持待清理", async () => {
		const prisma = makePrisma({
			targets: [
				target({ clientId: "keep", desiredVersion: 1, state: "installed", observedVersion: 1 }),
				target({ clientId: "removed", desiredVersion: null, state: "clear-pending" }),
			],
		});
		const { service } = makeService(prisma);
		await service.generate();
		const keep = prisma.targets.find((row) => row.clientId === "keep")!;
		const removed = prisma.targets.find((row) => row.clientId === "removed")!;
		expect(keep.desiredVersion).toBe(1);
		expect(keep.state).toBe("pending");
		expect(removed.desiredVersion).toBeNull();
		expect(removed.state).toBe("clear-pending");
	});

	it("status 只投影公钥与安全状态，不含密文", async () => {
		const prisma = makePrisma();
		const { service } = makeService(prisma);
		await service.generate();
		const status = await service.status();
		expect(status.key).toEqual({
			version: 1,
			publicKey: expect.stringMatching(/^ssh-ed25519 /),
			fingerprint: expect.stringMatching(/^SHA256:/),
		});
		expect(JSON.stringify(status)).not.toContain("ciphertext");
		expect(JSON.stringify(status)).not.toContain("keyVersion");
	});
});

describe("GitSshService 选机与下发", () => {
	it("未生成密钥时选机 fail closed", async () => {
		const prisma = makePrisma();
		const { service } = makeService(prisma);
		await expect(service.setTargets(["client-a"])).rejects.toMatchObject({
			code: "GIT_SSH_KEY_UNAVAILABLE",
		});
	});

	it("选机写入 pending，取消选机写入 clear-pending", async () => {
		const prisma = makePrisma();
		const { service } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a", "client-b"]);
		expect(prisma.targets.every((row) => row.state === "pending")).toBe(true);
		expect(prisma.targets.every((row) => row.desiredVersion === 1)).toBe(true);

		await service.setTargets(["client-b"]);
		const removed = prisma.targets.find((row) => row.clientId === "client-a")!;
		expect(removed.desiredVersion).toBeNull();
		expect(removed.state).toBe("clear-pending");
		expect(removed.operationId).not.toBeNull();
	});

	it("注册后向当前 socket 下发 install，指令含私钥但仅限该 socket", async () => {
		const prisma = makePrisma();
		const { service, sent, generatedPair } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a"]);
		await service.onRegistered("client-a", "socket-a", {
			available: true,
			protocolVersion: 1,
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]!.socketId).toBe("socket-a");
		const command = sent[0]!.command;
		expect(command.action).toBe("install");
		if (command.action !== "install") throw new Error("expected install command");
		expect(command.protocolVersion).toBe(1);
		expect(command.version).toBe(1);
		expect(command.publicKey).toBe(generatedPair()!.publicKey);
		expect(command.privateKey).toBe(generatedPair()!.privateKey);
		expect(prisma.targets[0]!.lastSentVersion).toBe(1);
	});

	it("未上报兼容能力的 Client 标记 unsupported 且不下发密钥", async () => {
		const prisma = makePrisma();
		const { service, sent } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a"]);
		await service.onRegistered("client-a", "socket-a", undefined);
		expect(sent).toHaveLength(0);
		expect(prisma.targets[0]!.state).toBe("unsupported");

		await service.onRegistered("client-a", "socket-a", {
			available: false,
			code: "GIT_SSH_UNAVAILABLE",
		});
		expect(sent).toHaveLength(0);
	});

	it("重复 Client ID 标记 ambiguous 且不下发私钥", async () => {
		const prisma = makePrisma();
		const { service, sent } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a"]);
		await service.onRegistered("client-a", "socket-1", {
			available: true,
			protocolVersion: 1,
		});
		expect(sent).toHaveLength(1);

		await service.onRegistered("client-a", "socket-2", {
			available: true,
			protocolVersion: 1,
		});
		expect(sent).toHaveLength(1); // 不对第二个 socket 重发秘密
		expect(prisma.targets[0]!.state).toBe("ambiguous");
	});

	it("重复连接收敛为唯一 socket 后重新下发", async () => {
		const prisma = makePrisma();
		const { service, sent } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a"]);
		await service.onRegistered("client-a", "socket-1", {
			available: true,
			protocolVersion: 1,
		});
		await service.onRegistered("client-a", "socket-2", {
			available: true,
			protocolVersion: 1,
		});
		sent.length = 0;
		await service.onDisconnected("client-a", "socket-1");
		expect(sent).toHaveLength(1);
		expect(sent[0]!.socketId).toBe("socket-2");
		expect(prisma.targets[0]!.state).toBe("pending");
	});

	it("离线 Client 保持待下发，重连时下发 clear", async () => {
		const prisma = makePrisma();
		const { service, sent } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a"]);
		await service.setTargets([]);
		expect(sent).toHaveLength(0);
		expect(prisma.targets[0]!.state).toBe("clear-pending");

		await service.onRegistered("client-a", "socket-a", {
			available: true,
			protocolVersion: 1,
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]!.command.action).toBe("clear");
		expect(sent[0]!.command.version).toBe(1);
		expect("privateKey" in sent[0]!.command).toBe(false);
	});

	it("已安装的 Client 重连时仍重发同版本 install（幂等由 Client 保证）", async () => {
		// 设计约束：Server 不得因“已收敛”而跳过重发。
		// 重发是自愈手段（本地副本被删/损坏时重新落盘）；若在 Server 侧跳过，
		// 本地副本丢失的机器将永远停在 installed 且无法恢复。
		// 同版本重复下发必须由 Client 视为幂等成功（见 client git-ssh-store 测试）。
		const prisma = makePrisma();
		const { service, sent } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a"]);
		await service.onRegistered("client-a", "socket-a", {
			available: true,
			protocolVersion: 1,
		});
		await service.applyAck("client-a", "socket-a", {
			protocolVersion: 1,
			operationId: String(sent[0]!.command.operationId),
			version: 1,
			state: "installed",
		});
		expect(prisma.targets[0]!.state).toBe("installed");

		sent.length = 0;
		await service.onDisconnected("client-a", "socket-a");
		await service.onRegistered("client-a", "socket-b", {
			available: true,
			protocolVersion: 1,
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]!.command.action).toBe("install");
		expect(sent[0]!.command.version).toBe(1);
	});

	it("换钥不下发给未上报能力的 Client，且不把它洗成 pending", async () => {
		const prisma = makePrisma();
		const { service, sent } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a"]);
		await service.onRegistered("client-a", "socket-a", undefined);
		expect(prisma.targets[0]!.state).toBe("unsupported");

		sent.length = 0;
		const rotated = await service.generate();

		expect(sent).toHaveLength(0);
		const row = prisma.targets[0]!;
		// 期望版本推进到新一代（能力恢复后会补发），但状态必须仍是 unsupported。
		expect(row.desiredVersion).toBe(rotated.version);
		expect(row.state).toBe("unsupported");
		expect(row.reasonCode).toBe("GIT_SSH_UNSUPPORTED");
	});

	it("状态投影校验持久化值：未知状态不投影，未知失败码省略", async () => {
		const prisma = makePrisma();
		const { service } = makeService(prisma);
		await service.generate();
		await service.setTargets(["client-a"]);

		// 越界状态：宁可该行缺席，也不输出契约外状态让 UI 渲染空白。
		prisma.targets[0]!.state = "weird-state";
		prisma.targets[0]!.reasonCode = "NOT_A_CODE";
		expect((await service.status()).targets).toEqual([]);

		// 状态合法但失败码越界：保留该行，省略失败码。
		prisma.targets[0]!.state = "failed";
		expect((await service.status()).targets).toEqual([
			{
				clientId: "client-a",
				desiredVersion: 1,
				observedVersion: null,
				state: "failed",
			},
		]);
	});
});

describe("GitSshService 回执对账", () => {
	async function prepared() {
		const prisma = makePrisma();
		const harness = makeService(prisma);
		await harness.service.generate();
		await harness.service.setTargets(["client-a"]);
		await harness.service.onRegistered("client-a", "socket-a", {
			available: true,
			protocolVersion: 1,
		});
		const install = harness.sent[0]!.command;
		return { prisma, ...harness, install };
	}

	it("合法回执更新 observedVersion 与 installed", async () => {
		const { service, prisma, install } = await prepared();
		await service.applyAck("client-a", "socket-a", {
			protocolVersion: 1,
			operationId: String(install.operationId),
			version: 1,
			state: "installed",
		});
		const row = prisma.targets[0]!;
		expect(row.state).toBe("installed");
		expect(row.observedVersion).toBe(1);
	});

	it("过期 operationId、非当前 socket 与非注册 Client 的回执一律忽略", async () => {
		const { service, prisma, install } = await prepared();
		await service.applyAck("client-a", "socket-a", {
			protocolVersion: 1,
			operationId: "stale-operation",
			version: 1,
			state: "installed",
		});
		await service.applyAck("client-a", "socket-other", {
			protocolVersion: 1,
			operationId: String(install.operationId),
			version: 1,
			state: "installed",
		});
		await service.applyAck("client-unknown", "socket-a", {
			protocolVersion: 1,
			operationId: String(install.operationId),
			version: 1,
			state: "installed",
		});
		expect(prisma.targets[0]!.state).toBe("pending");
		expect(prisma.targets[0]!.observedVersion).toBeNull();
	});

	it("失败回执记录稳定原因码", async () => {
		const { service, prisma, install } = await prepared();
		await service.applyAck("client-a", "socket-a", {
			protocolVersion: 1,
			operationId: String(install.operationId),
			version: 1,
			state: "failed",
			code: "GIT_SSH_INSTALL_FAILED",
		});
		expect(prisma.targets[0]!.state).toBe("failed");
		expect(prisma.targets[0]!.reasonCode).toBe("GIT_SSH_INSTALL_FAILED");
	});

	it("清理回执后若该机已被重新选机，则重新下发 install", async () => {
		const { service, prisma, sent, install } = await prepared();
		await service.setTargets([]); // → clear-pending，并下发 clear
		const clearCommand = sent.at(-1)!.command;
		await service.setTargets(["client-a"]); // 重新选机
		sent.length = 0;
		await service.applyAck("client-a", "socket-a", {
			protocolVersion: 1,
			operationId: String(clearCommand.operationId),
			version: 1,
			state: "cleared",
		});
		const row = prisma.targets[0]!;
		expect(row.observedVersion).toBeNull();
		expect(row.state).toBe("pending");
		expect(sent).toHaveLength(0); // 取消的 clear 回执不得清掉已重新下发的 install
		expect(String(install.operationId)).not.toBe(String(clearCommand.operationId));

		// 当前 install 回执仍可正常收敛
		const latest = prisma.targets[0]!.operationId;
		await service.applyAck("client-a", "socket-a", {
			protocolVersion: 1,
			operationId: String(latest),
			version: 1,
			state: "installed",
		});
		expect(prisma.targets[0]!.state).toBe("installed");
	});
});
