import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

const MAX_DATA_BYTES = 8 * 1024;

export interface RemoteDevAuditInput {
	sessionId: string;
	event: string;
	actorIdentityId?: string;
	data?: unknown;
}

export interface RemoteDevAuditInfo {
	id: number;
	sessionId: string;
	at: string;
	event: string;
	actorIdentityId?: string;
	data?: unknown;
}

function parseData(value: string | null): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

@Injectable()
export class RemoteDevAuditService {
	constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

	static withPrisma(prisma: PrismaService): RemoteDevAuditService {
		return new RemoteDevAuditService(prisma);
	}

	/** 只写生命周期/端口/权限元数据；超限降级为截断标记。 */
	async record(input: RemoteDevAuditInput): Promise<void> {
		let data: string | null = null;
		if (input.data !== undefined) {
			const encoded = JSON.stringify(input.data);
			data =
				encoded !== undefined && encoded.length <= MAX_DATA_BYTES
					? encoded
					: JSON.stringify({ truncated: true });
		}
		await this.prisma.remoteDevAuditEvent.create({
			data: {
				sessionId: input.sessionId,
				event: input.event,
				...(input.actorIdentityId
					? { actorIdentityId: input.actorIdentityId }
					: {}),
				data,
			},
		});
	}

	async list(
		sessionId: string,
		since = 0,
		limit = 100,
	): Promise<{ data: RemoteDevAuditInfo[]; nextSeq: number }> {
		const rows = await this.prisma.remoteDevAuditEvent.findMany({
			where: { sessionId, ...(since > 0 ? { id: { gt: since } } : {}) },
			orderBy: { id: "asc" },
			take: Math.min(200, Math.max(1, limit)),
		});
		const data = rows.map((row) => ({
			id: row.id,
			sessionId: row.sessionId,
			at: row.at.toISOString(),
			event: row.event,
			...(row.actorIdentityId ? { actorIdentityId: row.actorIdentityId } : {}),
			...(row.data ? { data: parseData(row.data) } : {}),
		}));
		return { data, nextSeq: data.at(-1)?.id ?? since };
	}
}
