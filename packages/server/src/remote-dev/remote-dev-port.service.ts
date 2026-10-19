import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { ActorContext, RemoteDevForwardToken } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { RemoteDevError } from "./remote-dev.service.js";

const DEFAULT_TTL_MS = 10 * 60_000;

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

interface TokenEntry {
	sessionId: string;
	portId: string;
	tokenHash: string;
	expiresAt: number;
	identityId: string;
}

/** 短期 forward token：只存 hash，不落 DB；Server 重启即失效。 */
@Injectable()
export class RemoteDevPortService {
	private readonly tokens = new Map<string, TokenEntry>();

	constructor(
		@Optional()
		@Inject(PrismaService)
		private readonly prisma?: PrismaService,
	) {}

	static withDeps(deps: {
		prisma?: PrismaService;
		now?: () => number;
		ttlMs?: number;
	}): RemoteDevPortService {
		const service = new RemoteDevPortService(deps.prisma);
		service.now = deps.now ?? (() => Date.now());
		service.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
		return service;
	}

	private now: () => number = () => Date.now();
	private ttlMs = DEFAULT_TTL_MS;

	async issueForwardToken(
		sessionId: string,
		portId: string,
		actor: ActorContext,
	): Promise<RemoteDevForwardToken> {
		if (this.prisma) {
			const port = await this.prisma.remoteDevPort.findUnique({
				where: { id: portId },
			});
			if (!port || port.sessionId !== sessionId || port.status !== "open") {
				throw new RemoteDevError("RDS_PORT_INVALID", "端口未打开", 409);
			}
			const session = await this.prisma.remoteDevSession.findUnique({
				where: { id: sessionId },
				select: { ownerIdentityId: true, state: true },
			});
			if (
				!session ||
				(session.state !== "active" && session.state !== "detached")
			) {
				throw new RemoteDevError("RDS_PORT_INVALID", "会话当前不可转发", 409);
			}
			if (
				session.ownerIdentityId &&
				session.ownerIdentityId !== actor.identityId
			) {
				throw new RemoteDevError(
					"RDS_OPERATOR_REQUIRED",
					"只有会话所有者可以签发转发 token",
					403,
				);
			}
		}
		const token = randomUUID();
		const expiresAt = this.now() + this.ttlMs;
		this.tokens.set(portId, {
			sessionId,
			portId,
			tokenHash: hash(token),
			expiresAt,
			identityId: actor.identityId,
		});
		return { token, expiresAt: new Date(expiresAt).toISOString() };
	}

	validateToken(
		sessionId: string,
		portId: string,
		token: string,
		now = this.now(),
	): boolean {
		const entry = this.tokens.get(portId);
		if (!entry || entry.sessionId !== sessionId) return false;
		if (entry.expiresAt <= now) {
			this.tokens.delete(portId);
			return false;
		}
		return entry.tokenHash === hash(token);
	}

	revokePort(portId: string): void {
		this.tokens.delete(portId);
	}
}
