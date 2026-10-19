import { Inject } from "@nestjs/common";
import {
	ConnectedSocket,
	MessageBody,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer,
} from "@nestjs/websockets";
import type { Namespace, Server, Socket } from "socket.io";
import {
	Events,
	RdsFrameDecoder,
	decodeRdsOpenPayload,
	encodeRdsFrame,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { RemoteDevPortService } from "./remote-dev-port.service.js";
import { RdsRelay } from "./rds-relay.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 跨 namespace 定向投递：Nest 注入的是本 namespace，`.server` 才是根 Server。 */
function tunnelNamespace(server: Server): Server | Namespace {
	const root = (server as unknown as { server?: Server }).server;
	return root?.of("/remote-dev/tunnel") ?? server;
}

/** CLI 入站数据面：Bearer/forward token 认证，按 streamId 路由到 Client 隧道。 */
@WebSocketGateway({ namespace: "/remote-dev/forward" })
export class RemoteDevForwardGateway {
	@WebSocketServer() server!: Server;
	private readonly socketsByPort = new Map<string, Set<Socket>>();

	constructor(
		@Inject(RemoteDevPortService) private readonly ports: RemoteDevPortService,
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(RdsRelay) private readonly relay: RdsRelay,
	) {}

	async handleConnection(client: Socket): Promise<void> {
		const token = client.handshake.auth?.token;
		const sessionId = client.handshake.auth?.sessionId;
		const portId = client.handshake.auth?.portId;
		if (
			typeof token !== "string" ||
			typeof sessionId !== "string" ||
			typeof portId !== "string"
		) {
			client.disconnect();
			return;
		}
		if (!this.ports.validateToken(sessionId, portId, token)) {
			client.disconnect();
			return;
		}
		const port = await this.prisma.remoteDevPort.findUnique({
			where: { id: portId },
		});
		if (!port || port.sessionId !== sessionId || port.status !== "open") {
			client.disconnect();
			return;
		}
		client.data.rdsSessionId = sessionId;
		client.data.rdsPortId = portId;
		client.data.rdsRemotePort = port.remotePort;
		const sockets = this.socketsByPort.get(portId) ?? new Set<Socket>();
		sockets.add(client);
		this.socketsByPort.set(portId, sockets);
		client.emit(Events.RDS_STREAM_HELLO, {
			sessionId,
			portId,
			remotePort: port.remotePort,
		});
	}

	handleDisconnect(client: Socket): void {
		const portId = client.data.rdsPortId;
		if (typeof portId === "string") {
			const sockets = this.socketsByPort.get(portId);
			sockets?.delete(client);
			if (sockets?.size === 0) this.socketsByPort.delete(portId);
		}
		for (const stream of this.relay.unbindCliSocket(client.id)) {
			const target = this.relay.toClient(stream.sessionId, {
				type: "CLOSE",
				streamId: stream.streamId,
			});
			if (!target) continue;
			tunnelNamespace(this.server).to(target.socketId).emit(Events.RDS_STREAM_FRAME, {
				sessionId: stream.sessionId,
				data: encodeRdsFrame({
					type: "CLOSE",
					streamId: stream.streamId,
				}),
			});
		}
	}

	/** 端口关闭/会话关闭时强制断开对应 forward，令牌撤销只是第一道门。 */
	disconnectPort(portId: string): void {
		const sockets = this.socketsByPort.get(portId);
		if (!sockets) return;
		this.socketsByPort.delete(portId);
		for (const socket of sockets) socket.disconnect(true);
	}

	@SubscribeMessage(Events.RDS_STREAM_HELLO)
	handleHello(
		@ConnectedSocket() client: Socket,
		@MessageBody() data: unknown,
	): void {
		if (!isRecord(data) || typeof data.streamId !== "number") return;
		if (!Number.isInteger(data.streamId) || data.streamId < 0) return;
		const sessionId = client.data.rdsSessionId;
		if (typeof sessionId !== "string") return;
		const existing = this.relay.toCli(sessionId, data.streamId, {
			type: "HEARTBEAT",
			streamId: data.streamId,
		});
		if (existing && existing.socketId !== client.id) {
			client.emit(Events.RDS_ERROR, {
				code: "RDS_STREAM_CONFLICT",
				message: "stream is already owned by another forward",
			});
			return;
		}
		this.relay.bindCli(sessionId, client.id, data.streamId);
	}

	@SubscribeMessage(Events.RDS_STREAM_FRAME)
	handleFrame(
		@ConnectedSocket() client: Socket,
		@MessageBody() data: unknown,
	): void {
		if (!isRecord(data) || !(data.data instanceof Uint8Array)) return;
		const sessionId = client.data.rdsSessionId;
		if (typeof sessionId !== "string") return;
		let frames;
		try {
			frames = new RdsFrameDecoder().push(data.data);
		} catch {
			client.emit(Events.RDS_ERROR, {
				code: "RDS_FRAME_INVALID",
				message: "invalid tunnel frame",
			});
			return;
		}
		for (const frame of frames) {
			const owner = this.relay.toCli(sessionId, frame.streamId, frame);
			const target = this.relay.toClient(sessionId, frame);
			if (!owner || owner.socketId !== client.id || !target) {
				client.emit(Events.RDS_ERROR, {
					code: "RDS_STREAM_UNKNOWN",
					message: "stream is not owned by this forward",
				});
				continue;
			}
			if (frame.type === "OPEN") {
				let opened;
				try {
					opened = decodeRdsOpenPayload(frame.payload ?? new Uint8Array(0));
				} catch {
					client.emit(Events.RDS_ERROR, {
						code: "RDS_FRAME_INVALID",
						message: "invalid OPEN payload",
					});
					continue;
				}
				if (opened.remotePort !== client.data.rdsRemotePort) {
					client.emit(Events.RDS_ERROR, {
						code: "RDS_PORT_FORBIDDEN",
						message: "OPEN port does not match approved port",
					});
					continue;
				}
			}
			tunnelNamespace(this.server).to(target.socketId).emit(Events.RDS_STREAM_FRAME, {
				sessionId,
				data: encodeRdsFrame(frame),
			});
		}
	}

	@SubscribeMessage(Events.RDS_STREAM_CLOSE)
	handleClose(
		@ConnectedSocket() client: Socket,
		@MessageBody() data: unknown,
	): void {
		if (!isRecord(data) || typeof data.streamId !== "number") return;
		const sessionId = client.data.rdsSessionId;
		if (typeof sessionId !== "string") return;
		const owner = this.relay.toCli(sessionId, data.streamId, {
			type: "CLOSE",
			streamId: data.streamId,
		});
		if (!owner || owner.socketId !== client.id) return;
		this.relay.unbindStream(sessionId, data.streamId);
		const target = this.relay.toClient(sessionId, {
			type: "CLOSE",
			streamId: data.streamId,
		});
		if (target) {
			tunnelNamespace(this.server).to(target.socketId).emit(Events.RDS_STREAM_FRAME, {
				sessionId,
				data: encodeRdsFrame({
					type: "CLOSE",
					streamId: data.streamId,
				}),
			});
		}
	}
}
