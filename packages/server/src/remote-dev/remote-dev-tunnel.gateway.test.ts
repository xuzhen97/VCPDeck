import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { Events, encodeRdsFrame } from "@vcpdeck/shared";
import { RdsRelay } from "./rds-relay.js";
import { RemoteDevTunnelGateway } from "./remote-dev-tunnel.gateway.js";

function makeSocket(auth: Record<string, unknown>, id = "tunnel-1") {
	return {
		id,
		handshake: { auth },
		data: {},
		disconnect: vi.fn(),
		join: vi.fn().mockResolvedValue(undefined),
		emit: vi.fn(),
	} as unknown as Socket;
}

function makeGateway(overrides: { state?: string; clientId?: string } = {}) {
	const remoteDev = {
		get: vi.fn().mockResolvedValue({
			sessionId: "r1",
			clientId: overrides.clientId ?? "c1",
			state: overrides.state ?? "active",
		}),
	};
	const relay = new RdsRelay();
	const gateway = new RemoteDevTunnelGateway(remoteDev as never, relay);
	const emit = vi.fn();
	const to = vi.fn(() => ({ emit }));
	gateway.server = { to } as never;
	return { gateway, relay, remoteDev, to, emit };
}

describe("RemoteDevTunnelGateway", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("PSK 不匹配时断开", async () => {
		vi.stubEnv("VCPDECK_PSK", "test-psk");
		const { gateway, remoteDev } = makeGateway();
		const socket = makeSocket({
			psk: "wrong",
			clientId: "c1",
			sessionId: "r1",
		});
		await gateway.handleConnection(socket);
		expect(socket.disconnect).toHaveBeenCalled();
		expect(remoteDev.get).not.toHaveBeenCalled();
	});

	it("会话不属于 Client 或状态不可用时断开", async () => {
		vi.stubEnv("VCPDECK_PSK", "test-psk");
		const wrongClient = makeGateway({ clientId: "c2" });
		const a = makeSocket({
			psk: "test-psk",
			clientId: "c1",
			sessionId: "r1",
		});
		await wrongClient.gateway.handleConnection(a);
		expect(a.disconnect).toHaveBeenCalled();

		const inactive = makeGateway({ state: "closed" });
		const b = makeSocket({
			psk: "test-psk",
			clientId: "c1",
			sessionId: "r1",
		});
		await inactive.gateway.handleConnection(b);
		expect(b.disconnect).toHaveBeenCalled();
	});

	it("合法连接绑定 relay，并把帧转发给 CLI", async () => {
		vi.stubEnv("VCPDECK_PSK", "test-psk");
		const { gateway, relay, to, emit } = makeGateway();
		const socket = makeSocket({
			psk: "test-psk",
			clientId: "c1",
			sessionId: "r1",
		});
		await gateway.handleConnection(socket);
		expect(socket.join).toHaveBeenCalledWith("rds-tunnel:r1");

		relay.bindCli("r1", "cli-socket", 7);
		gateway.handleFrame(socket, {
			sessionId: "r1",
			data: encodeRdsFrame({
				type: "DATA",
				streamId: 7,
				payload: new TextEncoder().encode("hi"),
			}),
		});
		expect(to).toHaveBeenCalledWith("cli-socket");
		expect(emit).toHaveBeenCalledWith(
			Events.RDS_STREAM_FRAME,
			expect.objectContaining({ sessionId: "r1", data: expect.any(Uint8Array) }),
		);
	});

	it("拒绝伪造其他 session 的帧", async () => {
		vi.stubEnv("VCPDECK_PSK", "test-psk");
		const { gateway, to } = makeGateway();
		const socket = makeSocket({
			psk: "test-psk",
			clientId: "c1",
			sessionId: "r1",
		});
		await gateway.handleConnection(socket);
		gateway.handleFrame(socket, {
			sessionId: "r2",
			data: encodeRdsFrame({ type: "HEARTBEAT", streamId: 1 }),
		});
		expect(to).not.toHaveBeenCalled();
	});

	it("Client 隧道断开或关闭流时通知 CLI 关闭", async () => {
		vi.stubEnv("VCPDECK_PSK", "test-psk");
		const { gateway, relay, to, emit } = makeGateway();
		const socket = makeSocket({
			psk: "test-psk",
			clientId: "c1",
			sessionId: "r1",
		});
		await gateway.handleConnection(socket);
		relay.bindCli("r1", "cli-socket", 7);

		gateway.handleClose(socket, { sessionId: "r1", streamId: 7 });
		expect(to).toHaveBeenCalledWith("cli-socket");
		expect(emit).toHaveBeenCalledWith(
			Events.RDS_STREAM_FRAME,
			expect.objectContaining({ sessionId: "r1" }),
		);

		relay.bindCli("r1", "cli-socket-2", 8);
		gateway.handleDisconnect(socket);
		expect(to).toHaveBeenCalledWith("cli-socket-2");
	});
});
