/**
 * Tailnet 凭据管理编排（Server 权威，ADR-0062）。
 *
 * 安全约束：
 * - `authKey` 只在导入与短时交付窗口内以明文存在，DB 只保存密文；
 * - 预留、交付、结算都走条件更新，避免并发 Job 重复取用同一凭据；
 * - 投影永不含 `authKey`、密文或掩码尾码；错误只返回稳定 code 与安全文案。
 *
 * 状态机：available → reserved →（交付）spent | reserved（reusable）→ available；
 * 结果不明一律落 `uncertain`，不自动回到 `available`。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
	PaginatedResult,
	TailnetKeyInfo,
	TailnetKeyInput,
	TailnetKeyUse,
	TailnetReuse,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import {
	loadTailnetKeyCipher,
	tailnetCipherFromKey,
	tailnetError,
	type TailnetKeyCipher,
} from "./tailnet-crypto.js";
import {
	createTailnetRootKey,
	isExplicitTailnetRootKey,
	readTailnetRootKey,
	resolveTailnetRootKeyPath,
} from "./tailnet-root-key.js";
import type {
	TailnetCredentialRow,
	TailnetPrisma,
	TailnetTransaction,
} from "./tailnet-prisma.js";

/** 统一安全文案：不暴露根密钥路径或底层异常。 */
const UNAVAILABLE_MESSAGE = "Tailnet 根密钥不可用";

function keyBusy(message: string): Error {
	return tailnetError("TAILNET_KEY_BUSY", message, 409);
}

/**
 * 预留失败的安全文案：只描述凭据当前状态与下一步，不含密文、掩码尾码或 Tailscale 侧细节。
 *
 * 前端只消费 `code`；这段文案服务于 CLI、SDK 与直接调 API 的运维。
 * `allowUncertainReuse` 为 true 时，`uncertain` 与 `single/unknown` 的说法必须分开：
 * 前者是「确认了但记录不可复用」，后者是「一次性密钥根本不能重复下发」。
 */
function describeUnusableCredential(
	row: TailnetCredentialRow | null,
	allowUncertainReuse = false,
): string {
	if (row === null) return "凭据不存在或不可取用";
	if (row.use === "reserved") return "凭据已被其它 Job 预留";
	if (row.use === "spent") return "凭据已消耗，需要重新导入";
	if (row.use === "uncertain") {
		if (!allowUncertainReuse) return "凭据状态不确定，需要重新导入";
		if (row.declaredReuse !== "reusable") {
			return "凭据状态不确定，且导入时未声明为可复用，不能重试";
		}
		return "凭据状态不确定，且正被其它操作占用";
	}
	return "凭据当前不可用";
}

@Injectable()
export class TailnetKeyService {
	constructor(
		@Inject(PrismaService) private readonly prisma: TailnetPrisma,
		// @Optional + TS 默认值：Nest DI 不读默认值，不标 Optional 会在 bootstrap 解析 Object token 时失败
		@Optional() private readonly env: NodeJS.ProcessEnv = process.env,
		@Optional() private readonly readFileImpl: (path: string) => Promise<string> = (path) =>
			readFile(path, "utf8"),
		// 受管根密钥的数据根基于 cwd；显式注入仅为单测可替换。
		@Optional() private readonly cwd: string = process.cwd(),
	) {}

	/**
	 * 取得加解密用的 cipher。
	 *
	 * 显式 `VCPDECK_TAILNET_KEY_FILE` 只读，缺失即 fail closed；
	 * 受管路径（`<appDir|cwd>/data/tailnet/root.key`）仅在**没有任何历史凭据**时
	 * 首次自动创建，已有密文而根密钥缺失/损坏/错绑时绝不静默换钥。
	 */
	private async requireCipher(): Promise<TailnetKeyCipher> {
		if (isExplicitTailnetRootKey(this.env)) {
			const cipher = await loadTailnetKeyCipher(this.env, this.readFileImpl);
			if (!cipher) {
				throw tailnetError("TAILNET_KEY_UNAVAILABLE", UNAVAILABLE_MESSAGE);
			}
			return cipher;
		}
		const path = resolveTailnetRootKeyPath(this.env, this.cwd);
		let existing: Buffer | null;
		try {
			existing = await readTailnetRootKey(path);
		} catch {
			// 损坏、符号链接或不可读：一律 fail closed，不覆盖重建。
			throw tailnetError("TAILNET_KEY_UNAVAILABLE", UNAVAILABLE_MESSAGE);
		}
		if (existing) return tailnetCipherFromKey(existing);
		// 没有根密钥：只有「数据库中还没有任何凭据密文」才允许首次自动创建。
		if (await this.hasCiphertextHistory()) {
			throw tailnetError("TAILNET_KEY_UNAVAILABLE", UNAVAILABLE_MESSAGE);
		}
		try {
			return tailnetCipherFromKey(await createTailnetRootKey(path));
		} catch {
			throw tailnetError("TAILNET_KEY_UNAVAILABLE", UNAVAILABLE_MESSAGE);
		}
	}

	/** 是否已有历史凭据密文；用于判断能否首次自动创建根密钥。 */
	private async hasCiphertextHistory(): Promise<boolean> {
		const total = await this.prisma.tailnetCredential.count();
		return total > 0;
	}

	private static toInfo(row: TailnetCredentialRow): TailnetKeyInfo {
		return {
			id: row.id,
			name: row.name,
			declaredReuse: row.declaredReuse as TailnetReuse,
			declaredExpiresAt: row.declaredExpiresAt
				? row.declaredExpiresAt.toISOString()
				: null,
			use: row.use as TailnetKeyUse,
			createdAt: row.createdAt.toISOString(),
		};
	}

	/** 加密保存新凭据；返回不含密文的元信息。 */
	async importKey(input: TailnetKeyInput): Promise<TailnetKeyInfo> {
		const cipher = await this.requireCipher();
		const encrypted = cipher.encrypt(input.authKey);
		const row = await this.prisma.tailnetCredential.create({
			data: {
				id: randomUUID(),
				name: input.name,
				ciphertext: encrypted.ciphertext,
				keyVersion: encrypted.keyVersion,
				declaredReuse: input.declaredReuse,
				declaredExpiresAt: input.declaredExpiresAt
					? new Date(input.declaredExpiresAt)
					: null,
			},
		});
		return TailnetKeyService.toInfo(row);
	}

	/** 分页列出凭据元信息；不返回密文。 */
	async listKeys(
		page: number,
		pageSize: number,
	): Promise<PaginatedResult<TailnetKeyInfo>> {
		const safePage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
		const safeSize = Number.isFinite(pageSize)
			? Math.min(100, Math.max(1, Math.trunc(pageSize)))
			: 20;
		const [total, rows] = await Promise.all([
			this.prisma.tailnetCredential.count(),
			this.prisma.tailnetCredential.findMany({
				orderBy: { createdAt: "desc" },
				skip: (safePage - 1) * safeSize,
				take: safeSize,
			}),
		]);
		return {
			data: rows.map((row) => TailnetKeyService.toInfo(row)),
			total,
			page: safePage,
			pageSize: safeSize,
			totalPages: total === 0 ? 0 : Math.ceil(total / safeSize),
		};
	}

	/**
	 * 删除本地凭据记录；**不调用 Tailscale 侧撤销**。
	 * 已被 Job 预留的凭据拒绝删除，避免交付中途记录消失。
	 */
	async deleteKey(id: string): Promise<{ deleted: true }> {
		const row = await this.prisma.tailnetCredential.findUnique({
			where: { id },
		});
		if (!row) {
			throw tailnetError("NOT_FOUND", "凭据不存在", 404);
		}
		if (row.use === "reserved") {
			throw keyBusy("凭据正在被 Job 使用，不能删除");
		}
		const result = await this.prisma.tailnetCredential.deleteMany({
			where: { id, use: { not: "reserved" } },
		});
		if (result.count !== 1) {
			throw keyBusy("凭据正在被 Job 使用，不能删除");
		}
		return { deleted: true };
	}

	/**
	 * 在调用方事务内预留凭据；同一 jobId 重复预留幂等。
	 *
	 * 条件更新保证并发下只有一个 Job 能拿到 `available` 的凭据。ADR-0064 的
	 * 唯一增量：操作者逐次确认后，`uncertain` 且声明为 `reusable` 的记录
	 * 也可以被预留一次；`single`/`unknown` 即使确认也不放开，仍走 fail closed。
	 */
	async reserve(
		tx: TailnetTransaction,
		id: string,
		jobId: string,
		options: { allowUncertainReuse?: boolean } = {},
	): Promise<void> {
		const existing = await tx.tailnetCredential.findUnique({
			where: { id },
		});
		if (
			existing &&
			existing.use === "reserved" &&
			existing.reservedJobId === jobId
		) {
			return;
		}
		const allowUncertainReuse = options.allowUncertainReuse === true;
		const result = await tx.tailnetCredential.updateMany({
			where: allowUncertainReuse
				? {
						id,
						reservedJobId: null,
						use: { in: ["available", "uncertain"] },
						declaredReuse: "reusable",
					}
				: { id, use: "available", reservedJobId: null },
			data: { use: "reserved", reservedJobId: jobId },
		});
		if (result.count !== 1) {
			throw keyBusy(describeUnusableCredential(existing, allowUncertainReuse));
		}
	}

	/**
	 * 短时交付明文；同一 Job 只允许交付一次。
	 *
	 * single/unknown 在交付成功后立即标记 `spent`；reusable 保持 reserved，
	 * 待 Job 终结后由 `settle` 决定回到 available 还是 uncertain。
	 */
	async issue(id: string, jobId: string): Promise<string> {
		const row = await this.prisma.tailnetCredential.findUnique({
			where: { id },
		});
		if (!row || row.reservedJobId !== jobId) {
			throw tailnetError(
				"TAILNET_OPERATION_MISMATCH",
				"凭据预留与当前 Job 不匹配",
				409,
			);
		}
		if (row.issuedAt) {
			throw keyBusy("凭据已交付，不重复下发");
		}
		if (row.use !== "reserved") {
			throw keyBusy("凭据不可取用");
		}
		const cipher = await this.requireCipher();
		let plaintext: string;
		try {
			plaintext = cipher.decrypt(row.ciphertext, row.keyVersion);
		} catch {
			// 根密钥错配或密文损坏：无法确认凭据是否仍可用，按结果不明处理。
			await this.settle(this.prisma, jobId, "uncertain");
			throw tailnetError("TAILNET_KEY_UNAVAILABLE", UNAVAILABLE_MESSAGE);
		}
		const nextUse: TailnetKeyUse =
			row.declaredReuse === "reusable" ? "reserved" : "spent";
		const result = await this.prisma.tailnetCredential.updateMany({
			where: { id, use: "reserved", reservedJobId: jobId, issuedAt: null },
			data: { issuedAt: new Date(), use: nextUse },
		});
		if (result.count !== 1) {
			throw keyBusy("凭据已被并发使用");
		}
		return plaintext;
	}

	/**
	 * 结算某 Job 的预留；幂等，找不到对应预留时静默返回。
	 *
	 * - `unused`：正文未下发时才回到 available；已下发则落 uncertain；
	 * - `consumed`：reusable 回到 available，其余落 spent；
	 * - `uncertain`：保持 uncertain，绝不自动重用。
	 */
	async settle(
		tx: TailnetTransaction,
		jobId: string,
		outcome: "unused" | "consumed" | "uncertain",
	): Promise<void> {
		const row = await tx.tailnetCredential.findFirst({
			where: { reservedJobId: jobId },
		});
		if (!row) return;
		if (outcome === "unused" && !row.issuedAt) {
			await tx.tailnetCredential.updateMany({
				where: { reservedJobId: jobId, issuedAt: null },
				data: { use: "available", reservedJobId: null },
			});
			return;
		}
		if (outcome === "consumed") {
			const nextUse: TailnetKeyUse =
				row.declaredReuse === "reusable" ? "available" : "spent";
			await tx.tailnetCredential.updateMany({
				where: { reservedJobId: jobId },
				data: { use: nextUse, reservedJobId: null },
			});
			return;
		}
		await tx.tailnetCredential.updateMany({
			where: { reservedJobId: jobId },
			data: { use: "uncertain", reservedJobId: null },
		});
	}
}
