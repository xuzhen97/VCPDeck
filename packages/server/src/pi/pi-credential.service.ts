/**
 * Pi Provider 凭据（Server 权威持久化，只存密文）。
 *
 * 明文只在本 Service 的加密/解密窗口内存在，绝不进入 API 响应、日志或审计。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
	PaginatedResult,
	PiCredentialCreateInput,
	PiCredentialInfo,
	PiCredentialLeaseEntryV2,
	PiCredentialUpdateInput,
	PiProviderProtocol,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { loadPiCredentialCipher } from "./pi-credential-crypto.js";

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

interface PiCredentialRow {
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
	providerConfig?: {
		name: string;
		runtimeProviderId: string;
		protocol: string | null;
		enabled: boolean;
	};
}

/** 对外投影：只暴露安全元数据。 */
function toInfo(row: PiCredentialRow): PiCredentialInfo {
	const provider = row.providerConfig;
	const protocol = provider?.protocol as PiProviderProtocol | null;
	return {
		id: row.id,
		name: row.name,
		providerConfigId: row.providerConfigId,
		providerName: provider?.name ?? row.provider,
		runtimeProviderId: provider?.runtimeProviderId ?? row.provider,
		protocol,
		fingerprint: row.fingerprint.slice(0, 8),
		keyVersion: row.keyVersion,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
		revokedAt: row.revokedAt?.toISOString() ?? null,
		configurationState:
			provider?.enabled === true && protocol !== null
				? "ready"
				: "needs_configuration",
	};
}

@Injectable()
export class PiCredentialService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		// @Optional + TS 默认值：Nest DI 不读默认值，不标 Optional 会在 bootstrap 解析 Object token 时直接失败
		@Optional() private readonly env: NodeJS.ProcessEnv = process.env,
		@Optional() private readonly readFileImpl: (path: string) => Promise<string> = (path) =>
			readFile(path, "utf8"),
	) {}

	/** 密钥未配置时 fail closed；不得降级为明文存储。 */
	private async cipher(): Promise<NonNullable<
		Awaited<ReturnType<typeof loadPiCredentialCipher>>
	>> {
		const cipher = await loadPiCredentialCipher(this.env, this.readFileImpl);
		if (!cipher) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Pi 凭据密钥未配置或非法");
		}
		return cipher;
	}

	async create(input: PiCredentialCreateInput): Promise<PiCredentialInfo> {
		const provider = await this.prisma.piProvider.findUnique({
			where: { id: input.providerConfigId },
		});
		if (!provider || !provider.enabled || provider.protocol === null) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Provider 不存在或尚未完成配置");
		}
		return this.createWithin(this.prisma, {
			providerConfigId: input.providerConfigId,
			runtimeProviderId: provider.runtimeProviderId,
			name: input.name,
			apiKey: input.apiKey,
		});
	}

	/**
	 * 在调用方事务内创建绑定凭据（Provider 一键接入的原子写入使用）。
	 * 明文只在本方法内加密一次；事务回滚时密文一并丢弃。
	 */
	async createWithin(
		prisma: Pick<PrismaService, "piCredential">,
		input: {
			providerConfigId: string;
			runtimeProviderId: string;
			name: string;
			apiKey: string;
		},
	): Promise<PiCredentialInfo> {
		const cipher = await this.cipher();
		const encrypted = cipher.encrypt(input.apiKey);
		const row = await prisma.piCredential.create({
			data: {
				id: randomUUID(),
				name: input.name,
				provider: input.runtimeProviderId,
				providerConfig: { connect: { id: input.providerConfigId } },
				ciphertext: encrypted.ciphertext,
				keyVersion: encrypted.keyVersion,
				fingerprint: encrypted.fingerprint,
			},
			include: { providerConfig: true },
		});
		return toInfo(row as unknown as PiCredentialRow);
	}

	async update(
		id: string,
		input: PiCredentialUpdateInput,
	): Promise<PiCredentialInfo> {
		const result = await this.prisma.$transaction(async (tx) => {
			const existing = await tx.piCredential.findUnique({ where: { id } });
			if (!existing) throw piError("PI_CONFIG_UNAVAILABLE", `凭据 "${id}" 不存在`);
			const data: Record<string, unknown> = {};
			if (input.name !== undefined) data.name = input.name;
			if (input.apiKey !== undefined) {
				const cipher = await this.cipher();
				const encrypted = cipher.encrypt(input.apiKey);
				data.ciphertext = encrypted.ciphertext;
				data.keyVersion = encrypted.keyVersion;
				data.fingerprint = encrypted.fingerprint;
			}
			const row = await tx.piCredential.update({
				where: { id },
				data,
				include: { providerConfig: true },
			});
			await this.bumpReferencingProfiles(id, tx);
			return row;
		});
		return toInfo(result as unknown as PiCredentialRow);
	}

	async revoke(id: string): Promise<PiCredentialInfo> {
		const result = await this.prisma.$transaction(async (tx) => {
			const existing = await tx.piCredential.findUnique({
				where: { id },
				include: { providerConfig: true },
			});
			if (!existing) throw piError("PI_CONFIG_UNAVAILABLE", `凭据 "${id}" 不存在`);
			if (existing.revokedAt !== null) return existing;
			const row = await tx.piCredential.update({
				where: { id },
				data: { revokedAt: new Date() },
				include: { providerConfig: true },
			});
			await this.bumpReferencingProfiles(id, tx);
			return row;
		});
		return toInfo(result as unknown as PiCredentialRow);
	}

	async list(page = 1, pageSize = 20): Promise<PaginatedResult<PiCredentialInfo>> {
		const [rows, total] = await Promise.all([
			this.prisma.piCredential.findMany({
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
				include: { providerConfig: true },
			}),
			this.prisma.piCredential.count(),
		]);
		return {
			data: (rows as unknown as PiCredentialRow[]).map(toInfo),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	/** 供 Provider 校验/发现使用：只在 Server 内存中解密一个有效凭据。 */
	async resolveProviderSecret(providerConfigId: string): Promise<string | null> {
		const cipher = await loadPiCredentialCipher(this.env, this.readFileImpl);
		if (!cipher) return null;
		const rows = await this.prisma.piCredential.findMany({
			where: { providerConfigId, revokedAt: null },
			orderBy: { updatedAt: "desc" },
		});
		for (const row of rows as unknown as PiCredentialRow[]) {
			try {
				return cipher.decrypt(row.ciphertext, row.keyVersion);
			} catch {
				// 不向 Provider 校验路径泄露解密失败细节，继续尝试下一条有效凭据。
			}
		}
		return null;
	}

	/**
	 * 解密 Profile 当前需要的凭据材料。
	 * 结果只允许进入 Client RuntimeSpec 的内存发送窗口。
	 */
	async resolveSecrets(profileId: string): Promise<PiCredentialLeaseEntryV2[]> {
		const cipher = await loadPiCredentialCipher(this.env, this.readFileImpl);
		if (!cipher) return [];
		const links = await this.prisma.piProfileCredential.findMany({
			where: { profileId },
		});
		const entries: PiCredentialLeaseEntryV2[] = [];
		const providerIds = new Set<string>();
		for (const link of links) {
			const row = await this.prisma.piCredential.findUnique({
				where: { id: link.credentialId },
				include: { providerConfig: true },
			});
			if (
				!row ||
				row.revokedAt !== null ||
				!row.providerConfig.enabled ||
				row.providerConfig.protocol === null ||
				providerIds.has(row.providerConfig.runtimeProviderId)
			) {
				continue;
			}
			try {
				entries.push({
					providerId: row.providerConfig.runtimeProviderId,
					apiKey: cipher.decrypt(row.ciphertext, row.keyVersion),
				});
				providerIds.add(row.providerConfig.runtimeProviderId);
			} catch {
				// 单条凭据不可解密时跳过，不泄露解密细节。
			}
		}
		return entries;
	}

	/** 记录最近一次使用时间（不含 Secret）。 */
	async markUsed(credentialId: string): Promise<void> {
		await this.prisma.piCredential.update({
			where: { id: credentialId },
			data: { lastUsedAt: new Date() },
		});
	}

	private async bumpReferencingProfiles(
		credentialId: string,
		prisma: Pick<PrismaService, "piProfileCredential" | "piProfile"> = this.prisma,
	): Promise<void> {
		const links = await prisma.piProfileCredential.findMany({
			where: { credentialId },
		});
		for (const link of links) {
			await prisma.piProfile.update({
				where: { id: link.profileId },
				data: { revision: { increment: 1 } },
			});
		}
	}
}
