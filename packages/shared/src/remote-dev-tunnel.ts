/**
 * RDS 数据面帧：version(1) | type(1) | streamId(4 BE) | length(4 BE) | payload。
 *
 * 只做帧编解码与边界校验，不解析业务正文。OPEN 的 payload 是受控 JSON
 * `{ remotePort }`；Client 只允许连接目标机 loopback。
 */
import {
	RDS_LIMITS,
	RemoteDevProtocolError,
} from "./remote-dev.js";

export const RDS_FRAME_VERSION = 1;
export const RDS_FRAME_TYPES = [
	"OPEN",
	"DATA",
	"CLOSE",
	"ERROR",
	"HEARTBEAT",
] as const;
export type RdsFrameType = (typeof RDS_FRAME_TYPES)[number];

const FRAME_TYPE_CODES: Record<RdsFrameType, number> = {
	OPEN: 1,
	DATA: 2,
	CLOSE: 3,
	ERROR: 4,
	HEARTBEAT: 5,
};
const FRAME_CODE_TYPES = new Map<number, RdsFrameType>(
	Object.entries(FRAME_TYPE_CODES).map(([type, code]) => [
		code,
		type as RdsFrameType,
	]),
);

export interface RdsTunnelFrame {
	type: RdsFrameType;
	streamId: number;
	payload?: Uint8Array;
}

export interface RdsOpenPayload {
	remotePort: number;
}

const HEADER_BYTES = 10;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function assertFrameType(value: string): RdsFrameType {
	if (!(RDS_FRAME_TYPES as readonly string[]).includes(value)) {
		throw new RemoteDevProtocolError(`未知 RDS 帧类型 ${value}`);
	}
	return value as RdsFrameType;
}

/** 编码一帧；超长 payload 与非法 streamId 直接失败。 */
export function encodeRdsFrame(frame: RdsTunnelFrame): Uint8Array {
	const type = assertFrameType(frame.type);
	if (
		typeof frame.streamId !== "number" ||
		!Number.isInteger(frame.streamId) ||
		frame.streamId < 0 ||
		frame.streamId > 0xffffffff
	) {
		throw new RemoteDevProtocolError("streamId 必须是 uint32");
	}
	const payload = frame.payload ?? new Uint8Array(0);
	if (payload.byteLength > RDS_LIMITS.maxFrameBytes) {
		throw new RemoteDevProtocolError(
			`RDS payload 超过 ${RDS_LIMITS.maxFrameBytes} 字节`,
		);
	}
	const result = new Uint8Array(HEADER_BYTES + payload.byteLength);
	const view = new DataView(result.buffer);
	view.setUint8(0, RDS_FRAME_VERSION);
	view.setUint8(1, FRAME_TYPE_CODES[type]);
	view.setUint32(2, frame.streamId, false);
	view.setUint32(6, payload.byteLength, false);
	result.set(payload, HEADER_BYTES);
	return result;
}

/** 增量解码器：允许半帧、一次多帧，按帧头聚合。 */
export class RdsFrameDecoder {
	private buffer = new Uint8Array(0);

	push(chunk: Uint8Array): RdsTunnelFrame[] {
		if (chunk.byteLength === 0) return [];
		const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		merged.set(this.buffer, 0);
		merged.set(chunk, this.buffer.byteLength);
		this.buffer = merged;

		const frames: RdsTunnelFrame[] = [];
		while (this.buffer.byteLength >= HEADER_BYTES) {
			const view = new DataView(
				this.buffer.buffer,
				this.buffer.byteOffset,
				this.buffer.byteLength,
			);
			if (view.getUint8(0) !== RDS_FRAME_VERSION) {
				throw new RemoteDevProtocolError("RDS 帧版本不匹配");
			}
			const type = FRAME_CODE_TYPES.get(view.getUint8(1));
			if (!type) throw new RemoteDevProtocolError("未知 RDS 帧类型");
			const streamId = view.getUint32(2, false);
			const length = view.getUint32(6, false);
			if (length > RDS_LIMITS.maxFrameBytes) {
				throw new RemoteDevProtocolError(
					`RDS payload 超过 ${RDS_LIMITS.maxFrameBytes} 字节`,
				);
			}
			if (this.buffer.byteLength < HEADER_BYTES + length) break;
			const payload = this.buffer.slice(
				HEADER_BYTES,
				HEADER_BYTES + length,
			);
			frames.push({ type, streamId, payload });
			this.buffer = this.buffer.slice(HEADER_BYTES + length);
		}
		return frames;
	}
}

/** 编码 OPEN 的受控 payload。 */
export function encodeRdsOpenPayload(payload: RdsOpenPayload): Uint8Array {
	assertOpenPort(payload.remotePort);
	return textEncoder.encode(JSON.stringify({ remotePort: payload.remotePort }));
}

/** 解码 OPEN payload；未知字段、非法端口一律拒绝。 */
export function decodeRdsOpenPayload(payload: Uint8Array): RdsOpenPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(textDecoder.decode(payload));
	} catch {
		throw new RemoteDevProtocolError("RDS OPEN payload 不是 JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new RemoteDevProtocolError("RDS OPEN payload 必须是对象");
	}
	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "remotePort") {
			throw new RemoteDevProtocolError(`RDS OPEN 含未知字段 ${key}`);
		}
	}
	assertOpenPort(record.remotePort);
	return { remotePort: record.remotePort };
}

function assertOpenPort(value: unknown): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < RDS_LIMITS.minPort ||
		value > RDS_LIMITS.maxPort
	) {
		throw new RemoteDevProtocolError(
			`remotePort 必须是 ${RDS_LIMITS.minPort}-${RDS_LIMITS.maxPort} 的整数`,
		);
	}
}
