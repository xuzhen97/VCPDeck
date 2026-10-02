/**
 * Git SSH 共享密钥分发编排（Server 权威）。
 *
 * 设计来源：docs/adr/0037、docs/adr/0038 与
 * `.tmp/specs/2026-09-30-git-ssh-key-distribution-design.md`：
 * - 私钥明文只在「加密写入」与「向已注册 socket 下发 install」两个窗口内存在；
 * - 选机只是运维分发范围，共享 PSK 下不构成每机身份认证；
 * - 本地清理确认只表示受管副本已删除，不等于 Git 服务侧已撤销。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
	GIT_SSH_PROTOCOL_VERSION,
	isGitSshFailureCode,
	isGitSshTargetState,
	type GitSshAck,
	type GitSshCapability,
	type GitSshCommand,
	type GitSshPublicInfo,
	type GitSshStatus,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import {
	generateGitSshEd25519KeyPair,
	gitSshCipherFromKey,
	gitSshError,
	loadGitSshKeyCipher,
	type GeneratedGitSshKeyPair,
	type GitSshKeyCipher,
} from "./git-ssh-crypto.js";
import {
	createGitSshRootKey,
	isExplicitGitSshRootKey,
	readGitSshRootKey,
	resolveGitSshRootKeyPath,
} from "./git-ssh-root-key.js";
import type {
	GitSshKeyRow,
	GitSshPrisma,
	GitSshTargetRow,
} from "./git-ssh-prisma.js";

/** Server → Client 的指令发送通道（由 ClientGateway.afterInit 绑定）。 */
export type GitSshSender = (socketId: string, command: GitSshCommand) => void;

@Injectable()
export class GitSshService {
	private sender: GitSshSender | null = null;
	/** clientId → 当前已 REGISTER 的 socket 集合（进程内租约，不持久化）。 */
	private readonly leases = new Map<string, Set<string>>();

	constructor(
		@Inject(PrismaService) private readonly prisma: GitSshPrisma,
		// @Optional + TS 默认值：Nest DI 不读默认值，不标 Optional 会在 bootstrap 解析 Object token 时直接失败
		@Optional() private readonly env: NodeJS.ProcessEnv = process.env,
		@Optional() private readonly readFileImpl: (path: string) => Promise<string> = (path) =>
			readFile(path, "utf8"),
		@Optional() private readonly keyGenerator: () => GeneratedGitSshKeyPair = generateGitSshEd25519KeyPair,
	) {}

	/** 由 ClientGateway.afterInit 绑定真实发送通道（同 PiRequestBroker 模式）。 */
	bindSender(sender: GitSshSender): void {
		this.sender = sender;
	}

	private send(socketId: string, command: GitSshCommand): void {
		this.sender?.(socketId, command);
	}

	/** 统一安全文案：不暴露路径、密钥或原始 IO 细节。 */
	private static readonly UNAVAILABLE = "Git SSH 根密钥不可用";

	/** 受管根密钥位置（显式配置或数据根默认路径）。 */
	private rootKeyPath(): string {
		return resolveGitSshRootKeyPath(this.env, process.cwd());
	}

	/**
	 * 只读解析根密钥 cipher；**不创建任何文件**。
	 *
	 * 返回 null 表示尚未创建或不可读，由调用方决定 fail closed 或跳过下发。
	 */
	private async readOnlyCipher(): Promise<GitSshKeyCipher | null> {
		if (isExplicitGitSshRootKey(this.env)) {
			return loadGitSshKeyCipher(this.env, this.readFileImpl);
		}
		let key: Buffer | null;
		try {
			key = await readGitSshRootKey(this.rootKeyPath());
		} catch {
			return null;
		}
		return key ? gitSshCipherFromKey(key) : null;
	}

	/**
	 * 「生成」使用的 cipher。
	 *
	 * 显式配置只读；受管路径仅在**没有任何历史密钥记录**时首次创建，
	 * 已有密文而根密钥缺失/损坏/错绑时必须 fail closed，绝不静默换钥。
	 */
	private async cipherForGenerate(hasHistory: boolean): Promise<GitSshKeyCipher> {
		if (isExplicitGitSshRootKey(this.env)) {
			const cipher = await loadGitSshKeyCipher(this.env, this.readFileImpl);
			if (!cipher) {
				throw gitSshError("GIT_SSH_KEY_UNAVAILABLE", GitSshService.UNAVAILABLE);
			}
			return cipher;
		}
		const path = this.rootKeyPath();
		const existing = await readGitSshRootKey(path);
		if (existing) return gitSshCipherFromKey(existing);
		if (hasHistory) {
			throw gitSshError("GIT_SSH_KEY_UNAVAILABLE", GitSshService.UNAVAILABLE);
		}
		return gitSshCipherFromKey(await createGitSshRootKey(path));
	}

	private async latestKey(): Promise<GitSshKeyRow | null> {
		return this.prisma.gitSshKey.findFirst({
			orderBy: { version: "desc" },
		});
	}

	private async keyByVersion(version: number): Promise<GitSshKeyRow | null> {
		return this.prisma.gitSshKey.findUnique({ where: { version } });
	}

	private async listTargets(): Promise<GitSshTargetRow[]> {
		return this.prisma.gitSshTarget.findMany({
			orderBy: { clientId: "asc" },
		});
	}

	private async targetRow(clientId: string): Promise<GitSshTargetRow | null> {
		return this.prisma.gitSshTarget.findUnique({ where: { clientId } });
	}

	private leaseFor(clientId: string): string | null {
		const sockets = this.leases.get(clientId);
		if (!sockets || sockets.size === 0) return null;
		return [...sockets][0] ?? null;
	}

	private leaseCount(clientId: string): number {
		return this.leases.get(clientId)?.size ?? 0;
	}

	/**
	 * 生成新一代密钥。
	 *
	 * 已选机的 Client 改判为新版本待下发；已取消选机的保持待清理。
	 * 生成成功不等于 Git 服务已登记新公钥，管理面不得代替操作者声明授权完成。
	 */
	async generate(): Promise<GitSshPublicInfo> {
		const latest = await this.latestKey();
		const cipher = await this.cipherForGenerate(latest !== null);
		// 既有密文必须能被当前根密钥解开：否则换代会让旧私钥永久不可读。
		if (latest) {
			try {
				cipher.decrypt(latest.ciphertext, latest.keyVersion);
			} catch {
				throw gitSshError(
					"GIT_SSH_KEY_UNAVAILABLE",
					"Git SSH 根密钥与既有密文不匹配",
				);
			}
		}
		const version = (latest?.version ?? 0) + 1;
		const pair = this.keyGenerator();
		const encrypted = cipher.encrypt(pair.privateKey);

		await this.prisma.gitSshKey.create({
			data: {
				id: randomUUID(),
				version,
				publicKey: pair.publicKey,
				fingerprint: pair.fingerprint,
				ciphertext: encrypted.ciphertext,
				keyVersion: encrypted.keyVersion,
			},
		});

		for (const row of await this.listTargets()) {
			if (row.desiredVersion === null) continue;
			// 保留 unsupported / ambiguous：它们表达的是「当前不能或不应下发」，
			// 换钥不应把它们洗成 pending。能力恢复（onRegistered）或重复连接收敛
			// （onDisconnected）时会重新判定并下发。
			const blocked =
				row.state === "unsupported" || row.state === "ambiguous";
			await this.prisma.gitSshTarget.update({
				where: { clientId: row.clientId },
				data: {
					desiredVersion: version,
					state: blocked ? row.state : "pending",
					reasonCode: blocked ? row.reasonCode : null,
					operationId: randomUUID(),
				},
			});
		}
		for (const row of await this.listTargets()) {
			// 与 setTargets 一致：不向重复连接（ambiguous）与未上报能力（unsupported）
			// 的目标下发。ambiguous 另有 pushTarget 的租约数守卫，这里保持状态语义一致。
			if (
				row.desiredVersion === version &&
				row.state !== "unsupported" &&
				row.state !== "ambiguous"
			) {
				await this.pushTarget(row.clientId);
			}
		}
		return {
			version,
			publicKey: pair.publicKey,
			fingerprint: pair.fingerprint,
		};
	}

	/** 管理面密钥投影；无密钥返回 null。永不返回密文或私钥。 */
	async getPublicInfo(): Promise<GitSshPublicInfo | null> {
		const row = await this.latestKey();
		if (!row) return null;
		return {
			version: row.version,
			publicKey: row.publicKey,
			fingerprint: row.fingerprint,
		};
	}

	/** 全量状态投影：密钥公钥信息 + 每机分发状态。 */
	async status(): Promise<GitSshStatus> {
		const key = await this.getPublicInfo();
		const targets = await this.listTargets();
		return {
			key,
			// 持久化列被越界写入（人工改库、未预期迁移）时不投影该行：
			// 宁可这台机器在状态列表里缺席，也不输出契约外状态让 UI 渲染空白。
			// 机器本身仍会出现在客户端列表里，操作者重新勾选即可自愈。
			targets: targets.flatMap((row) => {
				const state = row.state;
				if (!isGitSshTargetState(state)) return [];
				const reasonCode = row.reasonCode;
				return [
					{
						clientId: row.clientId,
						desiredVersion: row.desiredVersion,
						observedVersion: row.observedVersion,
						state,
						...(isGitSshFailureCode(reasonCode) ? { reasonCode } : {}),
					},
				];
			}),
		};
	}

	/**
	 * 替换选机集合。
	 *
	 * 未生成密钥时 fail closed：操作者必须先复制公钥并人工登记到 Git 服务。
	 */
	async setTargets(clientIds: string[]): Promise<GitSshStatus> {
		const latest = await this.latestKey();
		if (!latest) {
			throw gitSshError("GIT_SSH_KEY_UNAVAILABLE", "尚未生成 Git SSH 密钥");
		}
		const desired = new Set(clientIds);
		const existing = await this.listTargets();
		const existingIds = new Set(existing.map((row) => row.clientId));

		for (const clientId of clientIds) {
			if (existingIds.has(clientId)) continue;
			await this.prisma.gitSshTarget.upsert({
				where: { clientId },
				create: {
					clientId,
					desiredVersion: latest.version,
					observedVersion: null,
					state: "pending",
					reasonCode: null,
					operationId: randomUUID(),
					lastSentVersion: null,
				},
				update: {
					desiredVersion: latest.version,
					state: "pending",
					reasonCode: null,
					operationId: randomUUID(),
				},
			});
		}

		for (const row of existing) {
			if (desired.has(row.clientId)) {
				if (row.desiredVersion !== latest.version) {
					await this.prisma.gitSshTarget.update({
						where: { clientId: row.clientId },
						data: {
							desiredVersion: latest.version,
							state: "pending",
							reasonCode: null,
							operationId: randomUUID(),
						},
					});
				}
				continue;
			}
			// 取消选机：保持待清理，等 Client 回报清理确认。
			if (row.state === "cleared" && row.desiredVersion === null) continue;
			await this.prisma.gitSshTarget.update({
				where: { clientId: row.clientId },
				data: {
					desiredVersion: null,
					state: "clear-pending",
					reasonCode: null,
					operationId: randomUUID(),
				},
			});
		}

		for (const row of await this.listTargets()) {
			if (row.state === "unsupported" || row.state === "ambiguous") continue;
			await this.pushTarget(row.clientId);
		}
		return this.status();
	}

	/**
	 * 向当前唯一 socket 下发期望状态。
	 *
	 * 离线、重复连接、密钥行缺失或根密钥不可用时一律不下发（保持待同步）。
	 */
	private async pushTarget(clientId: string): Promise<void> {
		const socketId = this.leaseFor(clientId);
		if (!socketId || this.leaseCount(clientId) > 1) return;
		const row = await this.targetRow(clientId);
		if (!row) return;

		if (row.desiredVersion !== null) {
			const key = await this.keyByVersion(row.desiredVersion);
			if (!key) return;
			const cipher = await this.readOnlyCipher();
			if (!cipher) return;
			let privateKey: string;
			try {
				privateKey = cipher.decrypt(key.ciphertext, key.keyVersion);
			} catch {
				return;
			}
			const operationId = row.operationId ?? randomUUID();
			await this.prisma.gitSshTarget.update({
				where: { clientId },
				data: { operationId, lastSentVersion: key.version },
			});
			this.send(socketId, {
				protocolVersion: GIT_SSH_PROTOCOL_VERSION,
				operationId,
				version: key.version,
				action: "install",
				privateKey,
				publicKey: key.publicKey,
			});
			return;
		}

		const version =
			row.observedVersion ??
			row.lastSentVersion ??
			(await this.latestKey())?.version ??
			1;
		const operationId = row.operationId ?? randomUUID();
		await this.prisma.gitSshTarget.update({
			where: { clientId },
			data: { operationId },
		});
		this.send(socketId, {
			protocolVersion: GIT_SSH_PROTOCOL_VERSION,
			operationId,
			version,
			action: "clear",
		});
	}

	/**
	 * Client 注册后对账：登记租约，按能力与期望状态下发。
	 *
	 * 重复 Client ID 只标记 ambiguous 并不下发，避免把私钥投给未知接收方；
	 * 这不能阻止持有共享 PSK 的一方冒用 ID（ADR-0038）。
	 */
	async onRegistered(
		clientId: string,
		socketId: string,
		capability?: GitSshCapability,
	): Promise<void> {
		const sockets = this.leases.get(clientId) ?? new Set<string>();
		sockets.add(socketId);
		this.leases.set(clientId, sockets);

		const row = await this.targetRow(clientId);
		if (!row) return;

		if (!capability || capability.available !== true) {
			await this.prisma.gitSshTarget.update({
				where: { clientId },
				data: { state: "unsupported", reasonCode: "GIT_SSH_UNSUPPORTED" },
			});
			return;
		}
		if (sockets.size > 1) {
			await this.prisma.gitSshTarget.update({
				where: { clientId },
				data: { state: "ambiguous" },
			});
			return;
		}
		if (row.state === "unsupported") {
			await this.prisma.gitSshTarget.update({
				where: { clientId },
				data: {
					state: row.desiredVersion === null ? "clear-pending" : "pending",
					reasonCode: null,
				},
			});
		}
		await this.pushTarget(clientId);
	}

	/** Client 断开：清理租约；若收敛为唯一幸存 socket 则恢复下发。 */
	async onDisconnected(clientId: string, socketId: string): Promise<void> {
		const sockets = this.leases.get(clientId);
		if (sockets) {
			sockets.delete(socketId);
			if (sockets.size === 0) this.leases.delete(clientId);
		}
		if (!this.leaseFor(clientId) || this.leaseCount(clientId) > 1) return;

		const row = await this.targetRow(clientId);
		if (!row) return;
		if (row.state === "unsupported") return;
		if (row.state === "ambiguous") {
			await this.prisma.gitSshTarget.update({
				where: { clientId },
				data: {
					state: row.desiredVersion === null ? "clear-pending" : "pending",
				},
			});
		}
		await this.pushTarget(clientId);
	}

	/** 接收 Client 回执；socket 租约、Client 与 operationId 全部匹配才生效。 */
	async applyAck(
		clientId: string,
		socketId: string,
		ack: GitSshAck,
	): Promise<void> {
		if (this.leaseFor(clientId) !== socketId) return;
		const row = await this.targetRow(clientId);
		if (!row || row.operationId !== ack.operationId) return;

		if (ack.state === "failed") {
			await this.prisma.gitSshTarget.update({
				where: { clientId },
				data: { state: "failed", reasonCode: ack.code },
			});
			return;
		}

		if (ack.state === "installed") {
			const state =
				row.desiredVersion === ack.version
					? "installed"
					: row.desiredVersion === null
						? "clear-pending"
						: "pending";
			await this.prisma.gitSshTarget.update({
				where: { clientId },
				data: { observedVersion: ack.version, state, reasonCode: null },
			});
			if (state !== "installed") await this.pushTarget(clientId);
			return;
		}

		// cleared：只表示本地受管副本已删除，不代表 Git 服务侧已撤销访问。
		if (row.desiredVersion === null) {
			await this.prisma.gitSshTarget.update({
				where: { clientId },
				data: {
					observedVersion: null,
					state: "cleared",
					reasonCode: null,
					lastSentVersion: null,
				},
			});
			return;
		}
		await this.prisma.gitSshTarget.update({
			where: { clientId },
			data: { observedVersion: null, state: "pending", lastSentVersion: null },
		});
		await this.pushTarget(clientId);
	}
}
