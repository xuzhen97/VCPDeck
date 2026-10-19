import type { RdsTunnelFrame } from "@vcpdeck/shared";

interface RoutedFrame {
	socketId: string;
	frame: RdsTunnelFrame;
}

interface CliStream {
	socketId: string;
	sessionId: string;
	streamId: number;
}

/** 纯流多路复用映射；不持有 Socket，便于单测。 */
export class RdsRelay {
	private readonly clients = new Map<string, string>();
	private readonly cliStreams = new Map<string, CliStream>();
	private readonly cliSocketStreams = new Map<string, Set<string>>();

	bindClient(sessionId: string, socketId: string): void {
		this.clients.set(sessionId, socketId);
	}

	bindCli(sessionId: string, socketId: string, streamId: number): void {
		const key = this.key(sessionId, streamId);
		const previous = this.cliStreams.get(key);
		if (previous) this.removeFromSocket(previous.socketId, key);
		this.cliStreams.set(key, { socketId, sessionId, streamId });
		const keys = this.cliSocketStreams.get(socketId) ?? new Set<string>();
		keys.add(key);
		this.cliSocketStreams.set(socketId, keys);
	}

	unbindClient(sessionId: string): void {
		this.clients.delete(sessionId);
	}

	unbindStream(sessionId: string, streamId: number): void {
		const key = this.key(sessionId, streamId);
		const stream = this.cliStreams.get(key);
		if (!stream) return;
		this.cliStreams.delete(key);
		this.removeFromSocket(stream.socketId, key);
	}

	/** CLI 断线：返回该 socket 仍需通知 Client 关闭的流。 */
	unbindCliSocket(socketId: string): CliStream[] {
		const keys = this.cliSocketStreams.get(socketId);
		if (!keys) return [];
		const removed: CliStream[] = [];
		for (const key of keys) {
			const stream = this.cliStreams.get(key);
			if (stream) {
				this.cliStreams.delete(key);
				removed.push(stream);
			}
		}
		this.cliSocketStreams.delete(socketId);
		return removed;
	}

	/** Client 隧道断线：返回该 session 下所有待关闭的 CLI 流。 */
	takeSessionStreams(sessionId: string): CliStream[] {
		const removed: CliStream[] = [];
		for (const [key, stream] of this.cliStreams) {
			if (stream.sessionId !== sessionId) continue;
			this.cliStreams.delete(key);
			this.removeFromSocket(stream.socketId, key);
			removed.push(stream);
		}
		return removed;
	}

	toClient(sessionId: string, frame: RdsTunnelFrame): RoutedFrame | null {
		const socketId = this.clients.get(sessionId);
		return socketId ? { socketId, frame } : null;
	}

	toCli(
		sessionId: string,
		streamId: number,
		frame: RdsTunnelFrame,
	): RoutedFrame | null {
		const stream = this.cliStreams.get(this.key(sessionId, streamId));
		return stream ? { socketId: stream.socketId, frame } : null;
	}

	private removeFromSocket(socketId: string, key: string): void {
		const keys = this.cliSocketStreams.get(socketId);
		if (!keys) return;
		keys.delete(key);
		if (keys.size === 0) this.cliSocketStreams.delete(socketId);
	}

	private key(sessionId: string, streamId: number): string {
		return `${sessionId}:${streamId}`;
	}
}

export type { CliStream };
