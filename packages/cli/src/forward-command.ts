import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { io, type Socket } from "socket.io-client";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import {
	Events,
	RdsFrameDecoder,
	encodeRdsFrame,
	encodeRdsOpenPayload,
	type RdsTunnelFrame,
} from "@vcpdeck/shared";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { createAuthenticatedClient } from "./authenticated-client.js";
import type { ConfigPaths } from "./config.js";
import { resolveEnvironment } from "./environment.js";
import { envOverrideOf } from "./features-command.js";

export interface ForwardSocket {
	on(event: string, handler: (value: unknown) => void): void;
	emit(event: string, value: unknown): void;
	disconnect(): void;
}

export interface ForwarderOptions {
	serverBase: string;
	token: string;
	sessionId: string;
	portId: string;
	remotePort: number;
	localPort?: number;
	connectSocket?: (url: string, auth: Record<string, unknown>) => ForwardSocket;
}

export interface Forwarder {
	listen(): Promise<{ address: string; port: number }>;
	close(): Promise<void>;
}

interface LocalStream {
	socket: NetSocket;
}

/** 本地 loopback 监听；每条本地连接对应一个 RDS streamId。 */
export function createForwarder(options: ForwarderOptions): Forwarder {
	const socket = (options.connectSocket ?? defaultSocket)(
		`${options.serverBase.replace(/\/$/, "")}/remote-dev/forward`,
		{
			token: options.token,
			sessionId: options.sessionId,
			portId: options.portId,
		},
	);
	const streams = new Map<number, LocalStream>();
	let nextStreamId = 1;
	let server: Server | null = null;
	let closed = false;

	const shutdown = () => {
		if (closed) return;
		closed = true;
		for (const stream of streams.values()) stream.socket.destroy();
		streams.clear();
		server?.close();
	};

	const send = (frame: RdsTunnelFrame) => {
		socket.emit(Events.RDS_STREAM_FRAME, {
			sessionId: options.sessionId,
			data: encodeRdsFrame(frame),
		});
	};

	socket.on(Events.RDS_STREAM_FRAME, (payload: unknown) => {
		if (!isRecord(payload)) return;
		const data = payload.data;
		if (!(data instanceof Uint8Array || data instanceof ArrayBuffer)) return;
		let frames: RdsTunnelFrame[];
		try {
			frames = new RdsFrameDecoder().push(new Uint8Array(data as ArrayBuffer));
		} catch {
			return;
		}
		for (const frame of frames) {
			const stream = streams.get(frame.streamId);
			if (!stream) continue;
			if (frame.type === "DATA") {
				stream.socket.write(frame.payload ?? new Uint8Array(0));
			}
			if (frame.type === "CLOSE" || frame.type === "ERROR") {
				stream.socket.end();
				streams.delete(frame.streamId);
			}
		}
	});

	socket.on("disconnect", () => {
		shutdown();
	});

	return {
		listen() {
			server = createServer((local) => {
				const streamId = nextStreamId++;
				const stream: LocalStream = { socket: local };
				streams.set(streamId, stream);
				socket.emit(Events.RDS_STREAM_HELLO, {
					sessionId: options.sessionId,
					streamId,
				});
				send({
					type: "OPEN",
					streamId,
					payload: encodeRdsOpenPayload({ remotePort: options.remotePort }),
				});
				local.on("data", (chunk) => {
					send({
						type: "DATA",
						streamId,
						payload: new Uint8Array(chunk),
					});
				});
				local.on("close", () => {
					if (!streams.has(streamId)) return;
					streams.delete(streamId);
					send({ type: "CLOSE", streamId });
				});
				local.on("error", () => {
					if (!streams.has(streamId)) return;
					streams.delete(streamId);
					send({ type: "ERROR", streamId });
				});
			});
			return new Promise((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(
					options.localPort ?? options.remotePort,
					"127.0.0.1",
					() => {
						const address = server?.address();
						if (!address || typeof address === "string") {
							reject(new Error("forward listen failed"));
							return;
						}
						resolve({ address: address.address, port: address.port });
					},
				);
			});
		},
		async close() {
			closed = true;
			for (const stream of streams.values()) stream.socket.destroy();
			streams.clear();
			await new Promise<void>((resolve) => {
				if (!server || !server.listening) return resolve();
				server.close(() => resolve());
			});
			socket.disconnect();
		},
	};
}

function defaultSocket(url: string, auth: Record<string, unknown>): Socket {
	return io(url, {
		auth,
		transports: ["websocket"],
		reconnection: false,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ForwardCommandContext {
	paths?: ConfigPaths;
	processEnv?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	sdk?: VcpDeckClient;
	/** 测试注入；未提供 sdk 时从环境解析。 */
	serverBase?: string;
}

export function forwardUsage(): string {
	return [
		"Forward 命令:",
		"  vcpdeck forward --session=<id> --remote-port=<1024-65535> [--local-port=<0-65535>] [--env=<name>]",
		"  只监听 127.0.0.1；Ctrl+C 关闭监听与所有流。",
	].join("\n");
}

/** 命令行入口：查找/打开端口、签发短期 token、建立本地 loopback 监听。 */
export async function runForwardCommand(
	argv: string[],
	context: ForwardCommandContext = {},
): Promise<void> {
	const log = context.log ?? console.log;
	const { options } = parseCommandArgs(argv, {
		value: ["session", "remote-port", "local-port", "env", "environment"],
		boolean: [],
	});
	const sessionId = stringOption(options, "session");
	const remotePort = Number(stringOption(options, "remote-port"));
	if (
		!sessionId ||
		!Number.isInteger(remotePort) ||
		remotePort < 1024 ||
		remotePort > 65535
	) {
		throw new Error(forwardUsage());
	}
	const localPortRaw = stringOption(options, "local-port");
	const localPort = localPortRaw === undefined ? remotePort : Number(localPortRaw);
	if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
		throw new Error(forwardUsage());
	}

	let client = context.sdk;
	let serverBase = context.serverBase;
	if (!client) {
		const environment = await resolveEnvironment({
			environment: envOverrideOf(argv),
			paths: context.paths,
			processEnv: context.processEnv,
		});
		client = await createAuthenticatedClient(environment);
		serverBase = environment.server;
	}
	if (!serverBase) throw new Error("缺少 Server 地址");
	const ports = await client.remoteDev.ports.list(sessionId);
	let port = ports.find(
		(item) => item.remotePort === remotePort && item.status === "open",
	);
	if (!port) {
		port = await client.remoteDev.ports.open(sessionId, { remotePort });
	}
	const token = await client.remoteDev.ports.issueForwardToken(
		sessionId,
		port.portId,
	);
	const forwarder = createForwarder({
		serverBase,
		token: token.token,
		sessionId,
		portId: port.portId,
		remotePort,
		...(localPort !== remotePort ? { localPort } : {}),
	});
	const address = await forwarder.listen();
	log(
		`forwarding 127.0.0.1:${address.port} -> ${sessionId} 127.0.0.1:${remotePort}`,
	);
	process.once("SIGINT", () => {
		void forwarder.close().then(() => {
			process.exitCode = 0;
		});
	});
}

