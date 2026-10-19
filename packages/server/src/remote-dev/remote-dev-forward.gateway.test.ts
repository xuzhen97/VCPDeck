import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { Events, encodeRdsFrame, encodeRdsOpenPayload } from "@vcpdeck/shared";
import { RemoteDevForwardGateway } from "./remote-dev-forward.gateway.js";
import { RdsRelay } from "./rds-relay.js";

function makeSocket(auth: Record<string, unknown>, id = "forward-1") {
	return {
		id,
		handshake: { auth },
		data: {},
		disconnect: vi.fn(),
		emit: vi.fn(),
	} as unknown as Socket;
}

function makeGateway(options: { tokenOk?: boolean; status?: string } = {}) {
	const ports = {
		validateToken: vi.fn(() => options.tokenOk ?? true),
	};
	const prisma = {
		remoteDevPort: {
			findUnique: vi.fn().mockResolvedValue({
				id: "p1",
				sessionId: "r1",
				remotePort: 3000,
				status: options.status ?? "open",
			}),
		},
	};
	const relay = new RdsRelay();
	const gateway = new RemoteDevForwardGateway(
		ports as never,
		prisma as never,
		relay,
	);
	const emit = vi.fn();
	const to = vi.fn(() => ({ emit }));
	gateway.server = { to } as never;
	return { gateway, ports, relay, to, emit };
}

const AUTH = { token: "tok", sessionId: "r1", portId: "p1" };

describe("RemoteDevForwardGateway", () => {
	it("token 无效或端口未打开时断开", async () => {
		const badToken = makeGateway({ tokenOk: false });
		const a = makeSocket(AUTH);
		await badToken.gateway.handleConnection(a);
		expect(a.disconnect).toHaveBeenCalled();

		const closed = makeGateway({ status: "closed" });
		const b = makeSocket(AUTH);
		await closed.gateway.handleConnection(b);
		expect(b.disconnect).toHaveBeenCalled();
	});

	it("合法连接回 HELLO，并把 stream 绑定到 CLI", async () => {
		const { gateway, relay } = makeGateway();
		const socket = makeSocket(AUTH);
		await gateway.handleConnection(socket);
		expect(socket.emit).toHaveBeenCalledWith(Events.RDS_STREAM_HELLO, {
			sessionId: "r1",
			portId: "p1",
			remotePort: 3000,
		});
		expect(socket.disconnect).not.toHaveBeenCalled();

		gateway.handleHello(socket, { streamId: 5 });
		expect(
			relay.toCli("r1", 5, { type: "HEARTBEAT", streamId: 5 }),
		).toEqual({ socketId: "forward-1", frame: { type: "HEARTBEAT", streamId: 5 } });
	});

	it("CLI 断线通知 Client 关闭 stream", async () => {
		const { gateway, relay, to } = makeGateway();
		const socket = makeSocket(AUTH);
		await gateway.handleConnection(socket);
		gateway.handleHello(socket, { streamId: 5 });
		relay.bindClient("r1", "client-socket");

		gateway.handleDisconnect(socket);
		expect(to).toHaveBeenCalledWith("client-socket");
		expect(
			relay.toCli("r1", 5, { type: "HEARTBEAT", streamId: 5 }),
		).toBeNull();
	});

	it("关闭端口时主动断开 forward socket", async () => {
		const { gateway } = makeGateway();
		const socket = makeSocket(AUTH);
		await gateway.handleConnection(socket);
		gateway.disconnectPort("p1");
		expect(socket.disconnect).toHaveBeenCalledWith(true);
	});

	it("非法帧", async () => {
		const { gateway } = makeGateway();
		const socket = makeSocket(AUTH);
		await gateway.handleConnection(socket);
		gateway.handleFrame(socket, {
			data: new Uint8Array([9, 9, 0, 0, 0, 1, 0, 0, 0, 0]),
		});
		expect(socket.emit).toHaveBeenCalledWith(
			Events.RDS_ERROR,
			expect.objectContaining({ code: "RDS_FRAME_INVALID" }),
		);
	});

	it("拒绝未绑定流与篡改 OPEN 端口", async () => {		const { gateway, relay, to } = makeGateway();
		const socket = makeSocket(AUTH);
		await gateway.handleConnection(socket);
		relay.bindClient("r1", "client-socket");
		to.mockClear();

		gateway.handleFrame(socket, {
			data: encodeRdsFrame({
				type: "OPEN",
				streamId: 5,
				payload: encodeRdsOpenPayload({ remotePort: 3000 }),
			}),
		});
		expect(socket.emit).toHaveBeenCalledWith(
			Events.RDS_ERROR,
			expect.objectContaining({ code: "RDS_STREAM_UNKNOWN" }),
		);
		expect(to).not.toHaveBeenCalled();

		gateway.handleHello(socket, { streamId: 5 });
		gateway.handleFrame(socket, {
			data: encodeRdsFrame({
				type: "OPEN",
				streamId: 5,
				payload: encodeRdsOpenPayload({ remotePort: 4000 }),
			}),
		});
		expect(socket.emit).toHaveBeenCalledWith(
			Events.RDS_ERROR,
			expect.objectContaining({ code: "RDS_PORT_FORBIDDEN" }),
		);
		expect(to).not.toHaveBeenCalled();

		gateway.handleFrame(socket, {
			data: encodeRdsFrame({
				type: "OPEN",
				streamId: 5,
				payload: encodeRdsOpenPayload({ remotePort: 3000 }),
			}),
		});
		expect(to).toHaveBeenCalledWith("client-socket");
	});

	it("跨 namespace 投递走根 Server 的 tunnel namespace", async () => {
		const { gateway, relay } = makeGateway();
		const emit = vi.fn();
		const namespaceTo = vi.fn(() => ({ emit }));
		const root = { of: vi.fn(() => ({ to: namespaceTo })) };
		gateway.server = { to: vi.fn(), server: root } as never;
		const socket = makeSocket(AUTH);
		await gateway.handleConnection(socket);
		relay.bindClient("r1", "client-socket");
		gateway.handleHello(socket, { streamId: 5 });
		gateway.handleFrame(socket, {
			data: encodeRdsFrame({
				type: "OPEN",
				streamId: 5,
				payload: encodeRdsOpenPayload({ remotePort: 3000 }),
			}),
		});
		expect(root.of).toHaveBeenCalledWith("/remote-dev/tunnel");
		expect(namespaceTo).toHaveBeenCalledWith("client-socket");
		expect(emit).toHaveBeenCalledWith(
			Events.RDS_STREAM_FRAME,
			expect.objectContaining({ sessionId: "r1" }),
		);
	});
});
