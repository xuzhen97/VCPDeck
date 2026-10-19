import { describe, expect, it } from "vitest";
import { RdsRelay } from "./rds-relay.js";

function frame(type: "OPEN" | "DATA", streamId: number, text = "") {
	return {
		type,
		streamId,
		payload: new TextEncoder().encode(text),
	};
}

describe("RdsRelay", () => {
	it("relay 把 CLI stream 帧转发到 Client，把 Client 帧回传", () => {
		const relay = new RdsRelay();
		relay.bindClient("r1", "client-socket");
		relay.bindCli("r1", "cli-socket", 11);
		expect(relay.toClient("r1", frame("OPEN", 11))).toEqual({
			socketId: "client-socket",
			frame: frame("OPEN", 11),
		});
		expect(relay.toCli("r1", 11, frame("DATA", 11, "hi"))).toEqual({
			socketId: "cli-socket",
			frame: frame("DATA", 11, "hi"),
		});
	});

	it("未知 stream 不路由", () => {
		const relay = new RdsRelay();
		relay.bindClient("r1", "client-socket");
		expect(relay.toCli("r1", 99, frame("DATA", 99))).toBeNull();
	});

	it("CLI 断线返回待关闭流；Client 断线取走整个 session 的流", () => {
		const relay = new RdsRelay();
		relay.bindClient("r1", "client-1");
		relay.bindClient("r2", "client-2");
		relay.bindCli("r1", "cli-1", 1);
		relay.bindCli("r1", "cli-1", 2);
		relay.bindCli("r2", "cli-2", 3);

		expect(relay.unbindCliSocket("cli-1")).toEqual([
			{ socketId: "cli-1", sessionId: "r1", streamId: 1 },
			{ socketId: "cli-1", sessionId: "r1", streamId: 2 },
		]);
		expect(relay.toCli("r1", 1, frame("DATA", 1))).toBeNull();
		expect(relay.toCli("r2", 3, frame("DATA", 3))).not.toBeNull();

		expect(relay.takeSessionStreams("r2")).toEqual([
			{ socketId: "cli-2", sessionId: "r2", streamId: 3 },
		]);
		expect(relay.toCli("r2", 3, frame("DATA", 3))).toBeNull();
	});
});
