import { randomUUID, createHash } from "node:crypto";
import type { ActorContext } from "@vcpdeck/shared";

const OPERATOR_PROTECTION_MS = 30_000;

export type RemoteDevAttachmentMode = "operator" | "viewer";

interface Attachment {
	socketId: string;
	mode: RemoteDevAttachmentMode;
	identityId: string;
	tokenHash: string;
}

interface SessionAttachments {
	operatorSocketId: string | null;
	operatorIdentityId: string | null;
	operatorTokenHash: string | null;
	operatorProtectedUntil: number;
	attachments: Map<string, Attachment>;
}

export interface AttachResult {
	attachmentId: string;
	mode: RemoteDevAttachmentMode;
	reconnectToken: string;
	controlProtectedUntil?: string;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** RDS 浏览器 attachment：首个 operator，其余 viewer；token 只存 hash。 */
export class RemoteDevAttachmentService {
	private readonly sessions = new Map<string, SessionAttachments>();

	attach(
		sessionId: string,
		actor: ActorContext,
		socketId: string,
		reconnectToken?: string,
		now = Date.now(),
	): AttachResult {
		const state = this.state(sessionId);
		const existing = state.attachments.get(socketId);
		if (existing) {
			return {
				attachmentId: socketId,
				mode: existing.mode,
				reconnectToken: "",
				...(existing.mode === "operator"
					? {
							controlProtectedUntil: new Date(
								state.operatorProtectedUntil,
							).toISOString(),
						}
					: {}),
			};
		}

		const tokenHash = reconnectToken ? hash(reconnectToken) : null;
		const canReclaimOperator =
			tokenHash !== null &&
			state.operatorTokenHash === tokenHash &&
			state.operatorIdentityId === actor.identityId &&
			now < state.operatorProtectedUntil;
		if (canReclaimOperator && state.operatorSocketId && state.operatorSocketId !== socketId) {
			const previous = state.attachments.get(state.operatorSocketId);
			if (previous) previous.mode = "viewer";
		}
		const mode: RemoteDevAttachmentMode =
			state.operatorSocketId === null || canReclaimOperator ? "operator" : "viewer";
		const token = randomUUID();
		const attachment: Attachment = {
			socketId,
			mode,
			identityId: actor.identityId,
			tokenHash: hash(token),
		};
		state.attachments.set(socketId, attachment);
		if (mode === "operator") {
			state.operatorSocketId = socketId;
			state.operatorIdentityId = actor.identityId;
			state.operatorTokenHash = attachment.tokenHash;
			state.operatorProtectedUntil = now + OPERATOR_PROTECTION_MS;
		}
		return {
			attachmentId: socketId,
			mode,
			reconnectToken: token,
			...(mode === "operator"
				? {
						controlProtectedUntil: new Date(
							state.operatorProtectedUntil,
						).toISOString(),
					}
				: {}),
		};
	}

	detach(socketId: string): void {
		for (const state of this.sessions.values()) {
			const attachment = state.attachments.get(socketId);
			if (!attachment) continue;
			state.attachments.delete(socketId);
			if (state.operatorSocketId === socketId) {
				state.operatorSocketId = null;
				state.operatorProtectedUntil = Date.now() + OPERATOR_PROTECTION_MS;
			}
		}
	}

	takeover(sessionId: string, actor: ActorContext, socketId: string): void {
		const state = this.state(sessionId);
		const previous = state.operatorSocketId;
		if (previous && previous !== socketId) {
			const old = state.attachments.get(previous);
			if (old) old.mode = "viewer";
		}
		const attachment = state.attachments.get(socketId);
		if (attachment) {
			attachment.mode = "operator";
		} else {
			state.attachments.set(socketId, {
				socketId,
				mode: "operator",
				identityId: "",
				tokenHash: "",
			});
		}
		state.operatorSocketId = socketId;
		state.operatorIdentityId = actor.identityId;
		state.operatorProtectedUntil = Date.now() + OPERATOR_PROTECTION_MS;
	}

	assertOperator(sessionId: string, socketId: string): void {
		const state = this.sessions.get(sessionId);
		if (!state || state.operatorSocketId !== socketId) {
			throw Object.assign(new Error("operator required"), {
				code: "RDS_OPERATOR_REQUIRED",
			});
		}
	}

	modeOf(sessionId: string, socketId: string): RemoteDevAttachmentMode | null {
		return this.sessions.get(sessionId)?.attachments.get(socketId)?.mode ?? null;
	}

	socketsFor(sessionId: string): string[] {
		return [...(this.sessions.get(sessionId)?.attachments.keys() ?? [])];
	}

	clear(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	private state(sessionId: string): SessionAttachments {
		let state = this.sessions.get(sessionId);
		if (!state) {
			state = {
				operatorSocketId: null,
				operatorIdentityId: null,
				operatorTokenHash: null,
				operatorProtectedUntil: 0,
				attachments: new Map(),
			};
			this.sessions.set(sessionId, state);
		}
		return state;
	}
}
