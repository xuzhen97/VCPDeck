/**
 * 功能条目业务（ADR-0056）。
 *
 * 权威边界：条目是操作者/Agent 声明，Client 不感知、不上报、注册不覆盖。
 * `status` 是意图，`lastVerified*` 是证据；`active` 只能由成功验证产生，
 * 验证失败自动降级为 `draft`（`retired` 不被验证复活）。
 */
import { Inject, Injectable } from "@nestjs/common";
import {
	type ActorContext,
	type FeatureCreateInput,
	type FeatureErrorCode,
	type FeatureInfo,
	type FeatureInputParam,
	type FeatureInvocation,
	type FeatureUpdateInput,
	type FeatureVerification,
	type FeatureScope,
	type FeatureStatus,
	type PaginatedResult,
	FeatureProtocolError,
	getFeatureFreshness,
	parseFeatureContract,
} from "@vcpdeck/shared";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../../generated/client/index.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** 功能目录业务错误；Controller 原样映射 code 与 statusCode。 */
export class FeatureError extends Error {
	constructor(
		readonly code: FeatureErrorCode,
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "FeatureError";
	}
}

/** 存储契约损坏时的投影证据文案。 */
export const CORRUPT_CONTRACT_EVIDENCE = "存储内容损坏";

/** 功能条目查询条件。 */
export interface FeatureListQuery {
	clientId?: string;
	scope?: string;
	status?: string;
	page: number;
	pageSize: number;
}

/** 用于投影的数据库行（含 client 关联的选择列）。 */
interface FeatureRow {
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

const CLIENT_SELECT = {
	client: { select: { name: true, hostname: true } },
} as const;

@Injectable()
export class FeatureService {
	constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

	/** 分页查询功能条目；不做隐式过滤，retired 由调用方显式过滤。 */
	async list(
		query: FeatureListQuery,
		now = new Date(),
	): Promise<PaginatedResult<FeatureInfo>> {
		const where: Prisma.FeatureWhereInput = {
			...(query.clientId ? { clientId: query.clientId } : {}),
			...(query.scope ? { scope: query.scope } : {}),
			...(query.status ? { status: query.status } : {}),
		};
		const [rows, total] = await Promise.all([
			this.prisma.feature.findMany({
				where,
				include: CLIENT_SELECT,
				orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
				skip: (query.page - 1) * query.pageSize,
				take: query.pageSize,
			}),
			this.prisma.feature.count({ where }),
		]);
		return {
			data: rows.map((row) => this.toFeatureInfo(row, now)),
			total,
			page: query.page,
			pageSize: query.pageSize,
			totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
		};
	}

	/** 按 Client 分页查询（供机器工作区直接使用）。 */
	async listByClient(
		clientId: string,
		page: number,
		pageSize: number,
		now = new Date(),
	): Promise<PaginatedResult<FeatureInfo>> {
		return this.list({ clientId, page, pageSize }, now);
	}

	/** 读取单条；不存在抛 404。 */
	async get(id: string, now = new Date()): Promise<FeatureInfo> {
		const row = await this.prisma.feature.findUnique({
			where: { id },
			include: CLIENT_SELECT,
		});
		if (!row) throw new FeatureError("FEATURE_NOT_FOUND", "功能条目不存在", 404);
		return this.toFeatureInfo(row, now);
	}

	/**
	 * 创建条目。
	 * 无 `verification` 落 draft；`ok=true` 才落 active；失败也照常保存，由调用方决定退出码。
	 */
	async create(
		input: FeatureCreateInput,
		actor: ActorContext | null,
		now = new Date(),
	): Promise<FeatureInfo> {
		const client = await this.prisma.client.findUnique({
			where: { id: input.clientId },
			select: { id: true },
		});
		if (!client) {
			throw new FeatureError(
				"FEATURE_CLIENT_UNKNOWN",
				`Client "${input.clientId}" 不存在`,
				404,
			);
		}
		const verification = input.verification;
		const data: Prisma.FeatureUncheckedCreateInput = {
			id: `ft_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
			slug: input.slug,
			name: input.name,
			summary: input.summary,
			clientId: input.clientId,
			scope: input.scope,
			invoke: JSON.stringify(input.invoke),
			verify: JSON.stringify(input.verify),
			inputs: JSON.stringify(input.inputs),
			output: input.output,
			notes: input.notes,
			status: verification?.ok === true ? "active" : "draft",
			lastVerifiedAt: verification ? now : null,
			lastVerifiedOk: verification ? verification.ok : null,
			lastVerifyEvidence: verification?.evidence ?? null,
			verifiedVia: verification?.via ?? null,
			sourceJobId: input.sourceJobId,
			createdByIdentityId: actor?.identityId ?? null,
			createdByName: actor?.displayName ?? null,
			createdVia: actor?.source ?? null,
		};
		const row = await this.prisma.feature
			.create({ data, include: CLIENT_SELECT })
			.catch((error: unknown) => {
				if ((error as { code?: string } | null)?.code === "P2002") {
					throw new FeatureError(
						"FEATURE_SLUG_TAKEN",
						`slug "${input.slug}" 在该机器上已存在`,
						409,
					);
				}
				throw error;
			});
		return this.toFeatureInfo(row, now);
	}

	/** 更新契约字段或人工降级/退役；`active` 不可手写。 */
	async update(
		id: string,
		input: FeatureUpdateInput,
		now = new Date(),
	): Promise<FeatureInfo> {
		const existing = await this.prisma.feature.findUnique({
			where: { id },
			select: { id: true },
		});
		if (!existing) {
			throw new FeatureError("FEATURE_NOT_FOUND", "功能条目不存在", 404);
		}
		const data: Prisma.FeatureUpdateInput = {};
		if (input.name !== undefined) data.name = input.name;
		if (input.summary !== undefined) data.summary = input.summary;
		if (input.scope !== undefined) data.scope = input.scope;
		if (input.invoke !== undefined) data.invoke = JSON.stringify(input.invoke);
		if (input.verify !== undefined) data.verify = JSON.stringify(input.verify);
		if (input.inputs !== undefined) data.inputs = JSON.stringify(input.inputs);
		if (input.output !== undefined) data.output = input.output;
		if (input.notes !== undefined) data.notes = input.notes;
		if (input.status !== undefined) {
			// 纵深防御：shared parser 已拒绝 active，这里再挡一次。
			if ((input.status as string) === "active") {
				throw new FeatureError(
					"INVALID_FEATURE_STATUS_TRANSITION",
					"active 只能由一次成功验证产生",
					400,
				);
			}
			data.status = input.status;
		}
		const row = await this.prisma.feature.update({
			where: { id },
			data,
			include: CLIENT_SELECT,
		});
		return this.toFeatureInfo(row, now);
	}

	/** 记录一次验证结果；成功的验证把条目升为 active，失败降为 draft。 */
	async reportVerification(
		id: string,
		report: FeatureVerification,
		now = new Date(),
	): Promise<FeatureInfo> {
		const existing = await this.prisma.feature.findUnique({
			where: { id },
			select: { status: true },
		});
		if (!existing) {
			throw new FeatureError("FEATURE_NOT_FOUND", "功能条目不存在", 404);
		}
		const status =
			existing.status === "retired" ? "retired" : report.ok ? "active" : "draft";
		const row = await this.prisma.feature.update({
			where: { id },
			data: {
				status,
				lastVerifiedAt: now,
				lastVerifiedOk: report.ok,
				lastVerifyEvidence: report.evidence ?? null,
				verifiedVia: report.via,
			},
			include: CLIENT_SELECT,
		});
		return this.toFeatureInfo(row, now);
	}

	/** 投影为 REST 形态；存储契约损坏时只降级投影，不写回、不抛错。 */
	private toFeatureInfo(row: FeatureRow, now: Date): FeatureInfo {
		let contract: {
			invoke: FeatureInvocation;
			verify: FeatureInvocation;
			inputs: FeatureInputParam[];
		};
		let corrupt = false;
		try {
			contract = parseFeatureContract(
				JSON.parse(row.invoke),
				JSON.parse(row.verify),
				JSON.parse(row.inputs),
			);
		} catch (error) {
			if (!(error instanceof FeatureProtocolError) && !(error instanceof SyntaxError)) {
				throw error;
			}
			corrupt = true;
			contract = {
				invoke: { kind: "command", command: "", timeoutSeconds: 60 },
				verify: { kind: "command", command: "", timeoutSeconds: 60 },
				inputs: [],
			};
		}
		const lastVerifiedAt = row.lastVerifiedAt
			? row.lastVerifiedAt.toISOString()
			: null;
		return {
			id: row.id,
			slug: row.slug,
			name: row.name,
			summary: row.summary,
			clientId: row.clientId,
			clientName: row.client.name ?? row.client.hostname,
			scope: row.scope as FeatureScope,
			invoke: contract.invoke,
			verify: contract.verify,
			inputs: contract.inputs,
			output: row.output,
			notes: row.notes,
			status: corrupt ? "draft" : (row.status as FeatureStatus),
			freshness: getFeatureFreshness(lastVerifiedAt, now),
			lastVerifiedAt,
			lastVerifiedOk: row.lastVerifiedOk,
			lastVerifyEvidence: corrupt
				? CORRUPT_CONTRACT_EVIDENCE
				: row.lastVerifyEvidence,
			verifiedVia: row.verifiedVia,
			sourceJobId: row.sourceJobId,
			createdByName: row.createdByName,
			createdVia: row.createdVia,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}
}
