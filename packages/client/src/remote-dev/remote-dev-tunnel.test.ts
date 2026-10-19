import { describe, expect, it, vi } from "vitest";
import {
	Events,
	RdsFrameDecoder,
	encodeRdsFrame,
	encodeRdsOpenPayload,
	type RdsTunnelFrame,
} from "@vcpdeck/shared";
import { connectRemoteDevTunnel } from "./remote-dev-tunnel.js";

class FakeSocket {
	readonly handlers = new Map<string, Array<(value: unknown) => void>>();
	readonly emitted: Array<{ event: string; value: unknown }> = [];
	readonly disconnect = vi.fn();

	on(event: string, handler: (value: unknown) => void): this {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return this;
	}

	emit(event: string, value: unknown): this {
		this.emitted.push({ event, value });
		return this;
	}

	trigger(event: string, value: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(value);
	}
}

function fakeTarget() {
	const handlers = new Map<string, Array<(value: unknown) => void>>();
	return {
		handlers,
		write: vi.fn(),
		end: vi.fn(),
		destroy: vi.fn(),
		on(event: string, handler: (value: unknown) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return this;
		},
		emit(event: string, value: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(value);
		},
	};
}

function frameOf(socket: FakeSocket): RdsTunnelFrame[] {
	const frames: RdsTunnelFrame[] = [];
	for (const item of socket.emitted) {
		if (item.event !== Events.RDS_STREAM_FRAME) continue;
		const data = (item.value as { data: Uint8Array }).data;
		frames.push(...new RdsFrameDecoder().push(data));
	}
	return frames;
}

describe("connectRemoteDevTunnel", () => {
	it("OPEN 只把端口交给 127.0.0.1 连接器，并转发双向 DATA", () => {
		const socket = new FakeSocket();
		const target = fakeTarget();
		const connectTarget = vi.fn(() => target);
		const tunnel = connectRemoteDevTunnel({
			serverBase: "http://server",
			psk: "psk",
			clientId: "c1",
			sessionId: "r1",
			connectSocket: () => socket as never,
			connectTarget: connectTarget as never,
		});

		socket.trigger(Events.RDS_STREAM_FRAME, {
			sessionId: "r1",
			data: encodeRdsFrame({
				type: "OPEN",
				streamId: 7,
				payload: encodeRdsOpenPayload({ remotePort: 3000 }),
			}),
		});
		expect(connectTarget).toHaveBeenCalledWith(3000);

		socket.trigger(Events.RDS_STREAM_FRAME, {
			sessionId: "r1",
			data: encodeRdsFrame({
				type: "DATA",
				streamId: 7,
				payload: new TextEncoder().encode("from-cli"),
			}),
		});
		expect(target.write).toHaveBeenCalledWith(
			new TextEncoder().encode("from-cli"),
		);

		target.emit("data", Buffer.from("from-target"));
		expect(frameOf(socket)).toContainEqual(
			expect.objectContaining({
				type: "DATA",
				streamId: 7,
				payload: new TextEncoder().encode("from-target"),
			}),
		);

		socket.trigger(Events.RDS_STREAM_FRAME, {
			sessionId: "r1",
			data: encodeRdsFrame({ type: "CLOSE", streamId: 7 }),
		});
		expect(target.end).toHaveBeenCalled();

		tunnel.close();
		expect(socket.disconnect).toHaveBeenCalled();
	});

	it("非法 OPEN 端口回 ERROR，且不连接目标", () => {
		const socket = new FakeSocket();
		const connectTarget = vi.fn();
		connectRemoteDevTunnel({
			serverBase: "http://server",
			psk: "psk",
			clientId: "c1",
			sessionId: "r1",
			connectSocket: () => socket as never,
			connectTarget: connectTarget as never,
		});
		socket.trigger(Events.RDS_STREAM_FRAME, {
			sessionId: "r1",
			data: encodeRdsFrame({
				type: "OPEN",
				streamId: 8,
				payload: new TextEncoder().encode('{"remotePort":80}'),
			}),
		});
		expect(connectTarget).not.toHaveBeenCalled();
		expect(frameOf(socket)).toContainEqual(
			expect.objectContaining({ type: "ERROR", streamId: 8 }),
		);
	});

	it("目标 ERROR 回传 ERROR；其他 session 的帧被忽略", () => {
		const socket = new FakeSocket();
		const target = fakeTarget();
		connectRemoteDevTunnel({
			serverBase: "http://server",
			psk: "psk",
			clientId: "c1",
			sessionId: "r1",
			connectSocket: () => socket as never,
			connectTarget: () => target as never,
		});
		socket.trigger(Events.RDS_STREAM_FRAME, {
			sessionId: "other",
			data: encodeRdsFrame({
				type: "OPEN",
				streamId: 1,
				payload: encodeRdsOpenPayload({ remotePort: 3000 }),
			}),
		});
		expect(target.write).not.toHaveBeenCalled();
		expect(frameOf(socket)).toEqual([]);

		socket.trigger(Events.RDS_STREAM_FRAME, {
			sessionId: "r1",
			data: encodeRdsFrame({
				type: "OPEN",
				streamId: 5,
				payload: encodeRdsOpenPayload({ remotePort: 3000 }),
			}),
		});
		target.emit("error", new Error("refused"));
		expect(frameOf(socket)).toContainEqual(
			expect.objectContaining({ type: "ERROR", streamId: 5 }),
		);
	});
});
