import { connect as netConnect, type Socket as NetSocket } from "node:net";
import { io, type Socket } from "socket.io-client";
import {
	Events,
	RdsFrameDecoder,
	decodeRdsOpenPayload,
	encodeRdsFrame,
	type RdsTunnelFrame,
} from "@vcpdeck/shared";

export interface RemoteDevTunnelOptions {
	serverBase: string;
	psk: string;
	clientId: string;
	sessionId: string;
	connectSocket?: (url: string, auth: Record<string, unknown>) => Socket;
	connectTarget?: (port: number) => NetSocket;
}

export interface RemoteDevTunnel {
	close(): void;
}

/** Client 出站隧道：OPEN 只连接目标机 127.0.0.1，绝不接受远端 host。 */
export function connectRemoteDevTunnel(
	options: RemoteDevTunnelOptions,
): RemoteDevTunnel {
	const socket = (options.connectSocket ?? defaultSocket)(
		`${options.serverBase.replace(/\/$/, "")}/remote-dev/tunnel`,
		{ psk: options.psk, clientId: options.clientId, sessionId: options.sessionId },
	);
	const streams = new Map<number, NetSocket>();
	const decoder = new RdsFrameDecoder();

	const send = (frame: RdsTunnelFrame) => {
		socket.emit(Events.RDS_STREAM_FRAME, {
			sessionId: options.sessionId,
			data: encodeRdsFrame(frame),
		});
	};

	socket.on(Events.RDS_STREAM_FRAME, (payload: unknown) => {
		if (!isRecord(payload) || payload.sessionId !== options.sessionId) return;
		const data = payload.data;
		if (!(data instanceof Uint8Array || data instanceof ArrayBuffer)) return;
		let frames: RdsTunnelFrame[];
		try {
			frames = decoder.push(new Uint8Array(data as ArrayBuffer));
		} catch {
			return;
		}
		for (const frame of frames) {
			if (frame.type === "OPEN") {
				let target;
				try {
					target = decodeRdsOpenPayload(frame.payload ?? new Uint8Array(0));
				} catch {
					send({ type: "ERROR", streamId: frame.streamId });
					continue;
				}
				const stream = (options.connectTarget ?? connectTarget)(target.remotePort);
				streams.set(frame.streamId, stream);
				stream.on("data", (chunk: Buffer) => {
					send({
						type: "DATA",
						streamId: frame.streamId,
						payload: new Uint8Array(chunk),
					});
				});
				stream.on("close", () => {
					streams.delete(frame.streamId);
					send({ type: "CLOSE", streamId: frame.streamId });
				});
				stream.on("error", () => {
					streams.delete(frame.streamId);
					send({ type: "ERROR", streamId: frame.streamId });
				});
				continue;
			}
			const stream = streams.get(frame.streamId);
			if (!stream) continue;
			if (frame.type === "DATA") stream.write(frame.payload ?? new Uint8Array(0));
			if (frame.type === "CLOSE") stream.end();
			if (frame.type === "ERROR") stream.destroy();
		}
	});

	return {
		close() {
			for (const stream of streams.values()) stream.destroy();
			streams.clear();
			socket.disconnect();
		},
	};
}

function defaultSocket(url: string, auth: Record<string, unknown>): Socket {
	return io(url, { auth, transports: ["websocket"] });
}

function connectTarget(port: number): NetSocket {
	return netConnect({ host: "127.0.0.1", port });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
