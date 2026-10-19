import { describe, expect, it } from "vitest";
import {
	RDS_FRAME_VERSION,
	RdsFrameDecoder,
	decodeRdsOpenPayload,
	encodeRdsFrame,
	encodeRdsOpenPayload,
} from "./remote-dev-tunnel.js";

const text = (value: string) => new TextEncoder().encode(value);

describe("RDS 隧道帧", () => {
	it("分片到达时按帧头聚合", () => {
		const decoder = new RdsFrameDecoder();
		const encoded = encodeRdsFrame({
			type: "DATA",
			streamId: 7,
			payload: text("hello"),
		});
		expect(decoder.push(encoded.slice(0, 4))).toEqual([]);
		expect(decoder.push(encoded.slice(4))).toEqual([
			expect.objectContaining({
				type: "DATA",
				streamId: 7,
				payload: text("hello"),
			}),
		]);
	});

	it("支持一帧头加多帧和空 payload", () => {
		const decoder = new RdsFrameDecoder();
		const first = encodeRdsFrame({ type: "OPEN", streamId: 1 });
		const second = encodeRdsFrame({ type: "CLOSE", streamId: 2 });
		expect(decoder.push(new Uint8Array([...first, ...second]))).toEqual([
			expect.objectContaining({ type: "OPEN", streamId: 1 }),
			expect.objectContaining({ type: "CLOSE", streamId: 2 }),
		]);
	});

	it("拒绝非法 version、未知 type 与超长 payload", () => {
		const decoder = new RdsFrameDecoder();
		const frame = encodeRdsFrame({ type: "DATA", streamId: 1, payload: text("x") });
		const badVersion = new Uint8Array(frame);
		badVersion[0] = RDS_FRAME_VERSION + 1;
		expect(() => decoder.push(badVersion)).toThrow();
		expect(() =>
			encodeRdsFrame({
				type: "NOPE" as never,
				streamId: 1,
			}),
		).toThrow();
		expect(() =>
			encodeRdsFrame({
				type: "DATA",
				streamId: 1,
				payload: new Uint8Array(64 * 1024 + 1),
			}),
		).toThrow();
	});

	it("OPEN payload 是严格的 loopback 端口 JSON", () => {
		expect(decodeRdsOpenPayload(encodeRdsOpenPayload({ remotePort: 3000 }))).toEqual({
			remotePort: 3000,
		});
		expect(() =>
			decodeRdsOpenPayload(encodeRdsOpenPayload({ remotePort: 80 })),
		).toThrow();
		expect(() =>
			decodeRdsOpenPayload(text(JSON.stringify({ remotePort: 3000, host: "0.0.0.0" }))),
		).toThrow();
	});
});
