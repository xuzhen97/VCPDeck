import { Inject } from "@nestjs/common";
import {
	ConnectedSocket,
	MessageBody,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer,
} from "@nestjs/websockets";
import type { Namespace, Server, Socket } from "socket.io";
import { Events, RdsFrameDecoder, encodeRdsFrame } from "@vcpdeck/shared";
import { clientPsk } from "../client/client-psk.js";
import { RemoteDevService } from "./remote-dev.service.js";
import { RdsRelay } from "./rds-relay.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 跨 namespace 定向投递：Nest 注入的是本 namespace，`.server` 才是根 Server。 */
function forwardNamespace(server: Server): Server | Namespace {
	const root = (server as unknown as { server?: Server }).server;
	return root?.of("/remote-dev/forward") ?? server;
}

/** Client 出站数据面：一个 RDS 一条隧道，按 streamId 与 CLI 多路复用。 */
@WebSocketGateway({ namespace: "/remote-dev/tunnel" })
export class RemoteDevTunnelGateway {
	@WebSocketServer() server!: Server;

	constructor(
		@Inject(RemoteDevService) private readonly remoteDev: RemoteDevService,
		@Inject(RdsRelay) private readonly relay: RdsRelay,
	) {}

	async handleConnection(client: Socket): Promise<void> {
		if (client.handshake.auth?.psk !== clientPsk()) {
			client.disconnect();
			return;
		}
		const sessionId = client.handshake.auth?.sessionId;
		const clientId = client.handshake.auth?.clientId;
		if (typeof sessionId !== "string" || typeof clientId !== "string") {
			client.disconnect();
			return;
		}
		try {
			const session = await this.remoteDev.get(sessionId);
			if (
				session.clientId !== clientId ||
				(session.state !== "starting" &&
					session.state !== "active" &&
					session.state !== "detached")
			) {
				client.disconnect();
				return;
			}
		} catch {
			client.disconnect();
			return;
		}
		client.data.rdsSessionId = sessionId;
		this.relay.bindClient(sessionId, client.id);
		await client.join(`rds-tunnel:${sessionId}`);
	}

	handleDisconnect(client: Socket): void {
		const sessionId = client.data.rdsSessionId;
		if (typeof sessionId !== "string") return;
		this.relay.unbindClient(sessionId);
		for (const stream of this.relay.takeSessionStreams(sessionId)) {
			this.sendCloseToCli(stream.socketId, stream.sessionId, stream.streamId);
		}
	}

	@SubscribeMessage(Events.RDS_STREAM_FRAME)
	handleFrame(
		@ConnectedSocket() client: Socket,
		@MessageBody() data: unknown,
	): void {
		if (!isRecord(data) || typeof data.sessionId !== "string") return;
		if (data.sessionId !== client.data.rdsSessionId) return;
		if (!(data.data instanceof Uint8Array || data.data instanceof ArrayBuffer)) {
			return;
		}
		const decoder = new RdsFrameDecoder();
		let frames;
		try {
			frames = decoder.push(new Uint8Array(data.data as ArrayBuffer));
		} catch {
			client.emit(Events.RDS_ERROR, {
				code: "RDS_FRAME_INVALID",
				message: "invalid tunnel frame",
			});
			return;
		}
		for (const frame of frames) {
			const target = this.relay.toCli(data.sessionId, frame.streamId, frame);
			if (!target) continue;
			forwardNamespace(this.server).to(target.socketId).emit(Events.RDS_STREAM_FRAME, {
				sessionId: data.sessionId,
				data: encodeRdsFrame(frame),
			});
		}
	}

	@SubscribeMessage(Events.RDS_STREAM_CLOSE)
	handleClose(
		@ConnectedSocket() client: Socket,
		@MessageBody() data: unknown,
	): void {
		if (!isRecord(data) || typeof data.sessionId !== "string") return;
		if (data.sessionId !== client.data.rdsSessionId) return;
		if (typeof data.streamId !== "number" || !Number.isInteger(data.streamId)) {
			return;
		}
		const sessionId = data.sessionId;
		const target = this.relay.toCli(sessionId, data.streamId, {
			type: "CLOSE",
			streamId: data.streamId,
		});
		this.relay.unbindStream(sessionId, data.streamId);
		if (target) {
			this.sendCloseToCli(target.socketId, sessionId, data.streamId);
		}
	}

	private sendCloseToCli(
		socketId: string,
		sessionId: string,
		streamId: number,
	): void {
		forwardNamespace(this.server).to(socketId).emit(Events.RDS_STREAM_FRAME, {
			sessionId,
			data: encodeRdsFrame({ type: "CLOSE", streamId }),
		});
	}
}
