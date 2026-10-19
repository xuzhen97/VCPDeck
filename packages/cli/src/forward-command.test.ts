import { once } from "node:events";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { Events, RdsFrameDecoder } from "@vcpdeck/shared";
import { createForwarder } from "./forward-command.js";

function fakeSocket() {
	const handlers = new Map<string, (value: unknown) => void>();
	const emitted: Array<{ event: string; value: Record<string, unknown> }> = [];
	return {
		emitted,
		socket: {
			on(event: string, handler: (value: unknown) => void) {
				handlers.set(event, handler);
			},
			emit(event: string, value: unknown) {
				emitted.push({ event, value: value as Record<string, unknown> });
			},
			disconnect() {},
		},
	};
}

describe("vcpdeck forward", () => {
	it("只绑定 127.0.0.1，并为每个连接发 HELLO/OPEN", async () => {
		const fake = fakeSocket();
		const forwarder = createForwarder({
			serverBase: "http://127.0.0.1:1",
			token: "token",
			sessionId: "r1",
			portId: "p1",
			remotePort: 3000,
			localPort: 0,
			connectSocket: () => fake.socket,
		});
		const address = await forwarder.listen();
		expect(address.address).toBe("127.0.0.1");
		const client = connect(address.port, "127.0.0.1");
		await once(client, "connect");
		expect(fake.emitted.some((item) => item.event === Events.RDS_STREAM_HELLO)).toBe(
			true,
		);
		const frameEvent = fake.emitted.find(
			(item) => item.event === Events.RDS_STREAM_FRAME,
		);
		expect(frameEvent).toBeDefined();
		const frames = new RdsFrameDecoder().push(
			new Uint8Array(frameEvent?.value.data as ArrayBuffer),
		);
		expect(frames).toContainEqual(expect.objectContaining({ type: "OPEN" }));
		client.destroy();
		await forwarder.close();
	});

	it("非法参数不建立监听", async () => {
		const fake = fakeSocket();
		const forwarder = createForwarder({
			serverBase: "http://127.0.0.1:1",
			token: "token",
			sessionId: "r1",
			portId: "p1",
			remotePort: 3000,
			connectSocket: () => fake.socket,
		});
		const address = await forwarder.listen();
		expect(address.address).toBe("127.0.0.1");
		await forwarder.close();
	});
});
