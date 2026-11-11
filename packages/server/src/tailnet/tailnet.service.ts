import { Inject, Injectable } from "@nestjs/common";
import {
	TAILNET_CAPABILITY,
	TAILNET_PROTOCOL_VERSION,
	parseTailnetCapability,
	parseTailnetJobPayload,
	parseTailnetSecretRequest,
	parseTailnetSnapshot,
	type TailnetSecretResponse,
	type TailnetSnapshot,
	type TailnetStatus,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { TailnetKeyService } from "./tailnet-key.service.js";
import { tailnetError } from "./tailnet-crypto.js";

/** 密钥正文对 Client 的单次可见窗口：与 Client 端 30 秒等待同时生效。 */
const SECRET_TTL_MS = 30_000;

function parseJsonRecord(raw: string): Record<string, unknown> {
	try {
		const value = JSON.parse(raw) as unknown;
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseJsonArray(raw: string): string[] {
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Tailnet 控制面服务（ADR-0062）。
 *
 * 只做三件事：把只读摘要落到 Client 行；按需投影当前状态；
 * 对 Client 的密钥请求做完整所有权校验后，一次性交付短时正文。
 * 不依赖 Gateway / JobService，避免与 EventModule 形成反向依赖。
 */
@Injectable()
export class TailnetService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(TailnetKeyService) private readonly keys: TailnetKeyService,
	) {}

	/**
	 * 校验并交付一次 auth key。
	 *
	 * 任一必要检查失败都返回同一个稳定错误码，且绝不调用 `issue`——
	 * 解密只发生在所有权、任务状态、能力与预留全部成立之后。
	 */
	async authorizeSecret(
		socketId: string,
		raw: unknown,
	): Promise<TailnetSecretResponse> {
		let request: ReturnType<typeof parseTailnetSecretRequest>;
		try {
			request = parseTailnetSecretRequest(raw);
		} catch {
			throw this.mismatch("密钥请求不合法");
		}

		const client = await this.prisma.client.findFirst({
			where: { socketId },
		});
		if (!client || !client.online) throw this.mismatch("连接不属于在线机器");

		const job = await this.prisma.job.findUnique({
			where: { id: request.jobId },
		});
		if (!job || job.clientId !== client.id) throw this.mismatch("任务不属于该机器");
		if (job.type !== "tailnet.manage" || job.status !== "running") {
			throw this.mismatch("任务不是可交付的管理任务");
		}

		let payload: ReturnType<typeof parseTailnetJobPayload>;
		try {
			payload = parseTailnetJobPayload(parseJsonRecord(job.payload));
		} catch {
			throw this.mismatch("任务载荷不合法");
		}
		if (payload.action !== "ensure") throw this.mismatch("任务不申请密钥");

		const caps = parseJsonArray(client.capabilities);
		if (!caps.includes(TAILNET_CAPABILITY)) throw this.mismatch("机器未声明 Tailnet 能力");
		try {
			const capability = parseTailnetCapability(
				parseJsonRecord(client.capabilityDetails).tailnet,
			);
			if (capability.protocolVersion !== TAILNET_PROTOCOL_VERSION) {
				throw new Error("protocol mismatch");
			}
		} catch {
			throw this.mismatch("机器能力版本不支持");
		}

		const operation = await this.prisma.tailnetClientOperation.findUnique({
			where: { clientId: client.id },
		});
		if (!operation || operation.jobId !== job.id) {
			throw this.mismatch("管理占位不属于该任务");
		}

		const credential = await this.prisma.tailnetCredential.findUnique({
			where: { id: payload.credentialId },
		});
		if (
			!credential ||
			credential.reservedJobId !== job.id ||
			credential.issuedAt !== null
		) {
			throw this.mismatch("凭据未由该任务预留或已交付");
		}

		const authKey = await this.keys.issue(payload.credentialId, job.id);
		return {
			protocolVersion: TAILNET_PROTOCOL_VERSION,
			jobId: job.id,
			requestId: request.requestId,
			expiresAt: new Date(Date.now() + SECRET_TTL_MS).toISOString(),
			authKey,
		};
	}

	/** 持久化 Client 上报的只读摘要；非法摘要直接拒绝，不覆盖历史。 */
	async recordSnapshot(clientId: string, value: unknown): Promise<void> {
		const snapshot = parseTailnetSnapshot(value);
		await this.prisma.client.updateMany({
			where: { id: clientId },
			data: { tailnetSnapshot: JSON.stringify(snapshot) },
		});
	}

	/** 读取机器当前状态；离线时仍返回历史摘要，但 `online` 明确为 false。 */
	async getStatus(clientId: string): Promise<TailnetStatus> {
		const client = await this.prisma.client.findUnique({
			where: { id: clientId },
		});
		if (!client) throw tailnetError("CLIENT_NOT_FOUND", "机器不存在", 404);

		let supported = false;
		try {
			const capability = parseTailnetCapability(
				parseJsonRecord(client.capabilityDetails).tailnet,
			);
			supported =
				parseJsonArray(client.capabilities).includes(TAILNET_CAPABILITY) &&
				capability.protocolVersion === TAILNET_PROTOCOL_VERSION;
		} catch {
			supported = false;
		}

		let snapshot: TailnetSnapshot | null = null;
		if (client.tailnetSnapshot) {
			try {
				snapshot = parseTailnetSnapshot(JSON.parse(client.tailnetSnapshot));
			} catch {
				// 历史损坏：按从未报告处理，绝不用坏数据推断入网状态。
				snapshot = null;
			}
		}

		return {
			clientId: client.id,
			online: client.online,
			supported,
			snapshot,
		};
	}

	private mismatch(message: string): Error {
		return tailnetError("TAILNET_OPERATION_MISMATCH", message, 409);
	}
}
