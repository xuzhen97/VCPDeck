import { describe, expect, it } from "vitest";
import {
	TAILNET_ERROR_CODES,
	TAILNET_PROTOCOL_VERSION,
	assertTailnetSecretUsable,
	parseTailnetCapability,
	parseTailnetJobPayload,
	parseTailnetJobResult,
	parseTailnetKeyInfo,
	parseTailnetKeyInput,
	parseTailnetSecretRequest,
	parseTailnetSecretResponse,
	parseTailnetSnapshot,
	parseTailnetStatus,
} from "./tailnet.js";

const OBSERVED_AT = "2026-11-11T00:00:00.000Z";

/** 构造一份合法摘要；未知字段由调用方通过 overrides 注入。 */
function snapshot(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		installed: "yes",
		version: "1.104.5",
		service: "running",
		backend: "running",
		nodeName: "node.example.ts.net",
		ipv4: ["100.64.0.1"],
		ipv6: ["fd7a:115c:a1e0::1"],
		observedAt: OBSERVED_AT,
		errorCode: null,
		...overrides,
	};
}

function secretResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		protocolVersion: 1,
		jobId: "job-1",
		requestId: "request-1",
		expiresAt: "2026-11-11T00:00:30.000Z",
		authKey: "fake-secret",
		...overrides,
	};
}

type CodedError = Error & { code?: string };

function captureError(run: () => unknown): CodedError {
	try {
		run();
	} catch (error) {
		return error as CodedError;
	}
	throw new Error("期望抛出错误，但没有抛出");
}

describe("parseTailnetKeyInput", () => {
	it("原样保留 unknown 的声明属性", () => {
		const parsed = parseTailnetKeyInput({
			name: "test",
			authKey: "fake-secret",
			declaredReuse: "unknown",
			declaredExpiresAt: null,
		});
		expect(parsed.declaredReuse).toBe("unknown");
		expect(parsed.declaredExpiresAt).toBeNull();
	});

	it("拒绝未知字段、空名称、超长名称与超长密钥", () => {
		const base = {
			name: "test",
			authKey: "fake-secret",
			declaredReuse: "single",
			declaredExpiresAt: null,
		};
		expect(() => parseTailnetKeyInput({ ...base, extra: true })).toThrow();
		expect(() => parseTailnetKeyInput({ ...base, name: "" })).toThrow();
		expect(() => parseTailnetKeyInput({ ...base, name: "x".repeat(101) })).toThrow();
		expect(() => parseTailnetKeyInput({ ...base, authKey: "" })).toThrow();
		expect(() =>
			parseTailnetKeyInput({ ...base, authKey: "a".repeat(4097) }),
		).toThrow();
	});

	it("拒绝含 CR/LF/NUL 的密钥", () => {
		const base = {
			name: "test",
			declaredReuse: "single",
			declaredExpiresAt: null,
		};
		expect(() =>
			parseTailnetKeyInput({ ...base, authKey: "line1\nline2" }),
		).toThrow();
		expect(() =>
			parseTailnetKeyInput({ ...base, authKey: "line1\rline2" }),
		).toThrow();
		expect(() =>
			parseTailnetKeyInput({ ...base, authKey: "nul\u0000key" }),
		).toThrow();
	});

	it("拒绝非法日期与未知的复用声明", () => {
		const base = {
			name: "test",
			authKey: "fake-secret",
			declaredReuse: "single",
			declaredExpiresAt: null,
		};
		expect(() =>
			parseTailnetKeyInput({
				...base,
				declaredExpiresAt: "2026-13-45T00:00:00.000Z",
			}),
		).toThrow();
		expect(() =>
			parseTailnetKeyInput({ ...base, declaredExpiresAt: "not-a-date" }),
		).toThrow();
		expect(() =>
			parseTailnetKeyInput({ ...base, declaredExpiresAt: "2026-11-11" }),
		).toThrow();
		expect(() =>
			parseTailnetKeyInput({ ...base, declaredReuse: "maybe" }),
		).toThrow();
	});

	it("错误信息不回显密钥正文", () => {
		const error = captureError(() =>
			parseTailnetKeyInput({
				name: "test",
				authKey: "fake-secret",
				declaredReuse: "single",
				declaredExpiresAt: "bad-date",
			}),
		);
		expect(error.message).not.toContain("fake-secret");
	});
});

describe("parseTailnetJobPayload", () => {
	it("inspect 只允许 action 一个键", () => {
		expect(parseTailnetJobPayload({ action: "inspect" })).toEqual({
			action: "inspect",
		});
		expect(() =>
			parseTailnetJobPayload({ action: "inspect", credentialId: "k1" }),
		).toThrow();
	});

	it("ensure 接受精确键集并拒绝内联密钥", () => {
		expect(
			parseTailnetJobPayload({
				action: "ensure",
				credentialId: "k1",
				installIfMissing: false,
			}),
		).toEqual({
			action: "ensure",
			credentialId: "k1",
			installIfMissing: false,
		});
		const error = captureError(() =>
			parseTailnetJobPayload({
				action: "ensure",
				credentialId: "k1",
				installIfMissing: true,
				authKey: "fake-secret",
			}),
		);
		expect(error.message).not.toContain("fake-secret");
	});

	it("拒绝未知 action、缺失字段、非布尔安装意愿与超长 ID", () => {
		expect(() => parseTailnetJobPayload({ action: "delete" })).toThrow();
		expect(() =>
			parseTailnetJobPayload({ action: "ensure", credentialId: "k1" }),
		).toThrow();
		expect(() =>
			parseTailnetJobPayload({
				action: "ensure",
				credentialId: "k1",
				installIfMissing: "yes",
			}),
		).toThrow();
		expect(() =>
			parseTailnetJobPayload({
				action: "ensure",
				credentialId: "x".repeat(129),
				installIfMissing: false,
			}),
		).toThrow();
		expect(() => parseTailnetJobPayload(null)).toThrow();
	});
});

describe("parseTailnetSnapshot", () => {
	it("接受完整摘要并保留未知状态", () => {
		const parsed = parseTailnetSnapshot(
			snapshot({
				installed: "unknown",
				service: "unknown",
				backend: "unknown",
				version: null,
				nodeName: null,
				errorCode: TAILNET_ERROR_CODES.CLI_MISSING,
			}),
		);
		expect(parsed.installed).toBe("unknown");
		expect(parsed.backend).toBe("unknown");
		expect(parsed.errorCode).toBe(TAILNET_ERROR_CODES.CLI_MISSING);
	});

	it("拒绝 Peer 与其他未知字段，摘要不可夹带网络拓扑", () => {
		expect(() =>
			parseTailnetSnapshot(
				snapshot({ peer: { private: { HostName: "must-not-upload" } } }),
			),
		).toThrow();
		const error = captureError(() =>
			parseTailnetSnapshot(snapshot({ peer: { HostName: "must-not-upload" } })),
		);
		expect(error.message).not.toContain("must-not-upload");
	});

	it("拒绝未知枚举值与任意错误码文本", () => {
		expect(() =>
			parseTailnetSnapshot(snapshot({ backend: "FutureState" })),
		).toThrow();
		expect(() =>
			parseTailnetSnapshot(snapshot({ errorCode: "some cli stderr" })),
		).toThrow();
	});

	it("校验 IP 字面量、地址数量与观测时间", () => {
		expect(parseTailnetSnapshot(snapshot({ ipv4: [], ipv6: [] })).ipv4).toEqual(
			[],
		);
		expect(parseTailnetSnapshot(snapshot({ ipv6: ["::"] })).ipv6).toEqual([
			"::",
		]);
		expect(() =>
			parseTailnetSnapshot(snapshot({ ipv4: ["100.64.0.256"] })),
		).toThrow();
		expect(() =>
			parseTailnetSnapshot(snapshot({ ipv4: ["01.64.0.1"] })),
		).toThrow();
		expect(() =>
			parseTailnetSnapshot(snapshot({ ipv4: ["fd7a:115c:a1e0::1"] })),
		).toThrow();
		expect(() =>
			parseTailnetSnapshot(snapshot({ ipv6: ["fd7a:115c:a1e0::1::2"] })),
		).toThrow();
		expect(() =>
			parseTailnetSnapshot(snapshot({ ipv6: ["fd7a:115c:a1e0::12345"] })),
		).toThrow();
		expect(() =>
			parseTailnetSnapshot(snapshot({ ipv6: ["100.64.0.1"] })),
		).toThrow();
		expect(() =>
			parseTailnetSnapshot(
				snapshot({ ipv4: Array.from({ length: 17 }, () => "100.64.0.1") }),
			),
		).toThrow();
		expect(() =>
			parseTailnetSnapshot(snapshot({ observedAt: "2026-11-11" })),
		).toThrow();
	});
});

describe("parseTailnetSecretRequest / Response", () => {
	it("解析请求并拒绝未知协议版本与额外字段", () => {
		expect(
			parseTailnetSecretRequest({
				protocolVersion: 1,
				jobId: "job-1",
				requestId: "request-1",
			}),
		).toEqual({
			protocolVersion: 1,
			jobId: "job-1",
			requestId: "request-1",
		});
		expect(() =>
			parseTailnetSecretRequest({
				protocolVersion: 2,
				jobId: "job-1",
				requestId: "request-1",
			}),
		).toThrow();
		expect(() =>
			parseTailnetSecretRequest({
				protocolVersion: 1,
				jobId: "job-1",
				requestId: "request-1",
				authKey: "fake-secret",
			}),
		).toThrow();
	});

	it("消费方拒绝超期响应与其他 jobId/requestId 的响应", () => {
		const parsed = parseTailnetSecretResponse(secretResponse());
		const expected = { jobId: "job-1", requestId: "request-1" };
		expect(() =>
			assertTailnetSecretUsable(
				parsed,
				expected,
				Date.parse("2026-11-11T00:00:10.000Z"),
			),
		).not.toThrow();
		expect(
			captureError(() =>
				assertTailnetSecretUsable(
					parsed,
					expected,
					Date.parse("2026-11-11T00:00:30.000Z"),
				),
			).code,
		).toBe(TAILNET_ERROR_CODES.SECRET_EXPIRED);
		expect(
			captureError(() =>
				assertTailnetSecretUsable(parsed, {
					jobId: "job-2",
					requestId: "request-1",
				}),
			).code,
		).toBe(TAILNET_ERROR_CODES.SECRET_MISMATCH);
		expect(
			captureError(() =>
				assertTailnetSecretUsable(parsed, {
					jobId: "job-1",
					requestId: "request-2",
				}),
			).code,
		).toBe(TAILNET_ERROR_CODES.SECRET_MISMATCH);
	});

	it("拒绝空密钥、超长密钥与非法到期时间", () => {
		expect(() =>
			parseTailnetSecretResponse(secretResponse({ authKey: "" })),
		).toThrow();
		expect(() =>
			parseTailnetSecretResponse(secretResponse({ authKey: "a".repeat(4097) })),
		).toThrow();
		expect(() =>
			parseTailnetSecretResponse(secretResponse({ expiresAt: "tomorrow" })),
		).toThrow();
	});
});

describe("parseTailnetCapability / Status / KeyInfo", () => {
	it("能力仅接受协议版本 1", () => {
		expect(TAILNET_PROTOCOL_VERSION).toBe(1);
		expect(parseTailnetCapability({ protocolVersion: 1 })).toEqual({
			protocolVersion: 1,
		});
		expect(() =>
			parseTailnetCapability({ protocolVersion: 2 }),
		).toThrow();
		expect(() =>
			parseTailnetCapability({ protocolVersion: 1, installed: true }),
		).toThrow();
	});

	it("状态允许离线与缺失摘要，但不宽松猜测", () => {
		expect(
			parseTailnetStatus({
				clientId: "c1",
				online: false,
				supported: false,
				snapshot: null,
			}),
		).toEqual({
			clientId: "c1",
			online: false,
			supported: false,
			snapshot: null,
		});
		const online = parseTailnetStatus({
			clientId: "c1",
			online: true,
			supported: true,
			snapshot: snapshot(),
		});
		expect(online.snapshot?.backend).toBe("running");
		expect(() =>
			parseTailnetStatus({
				clientId: "c1",
				online: "yes",
				supported: true,
				snapshot: null,
			}),
		).toThrow();
		expect(() =>
			parseTailnetStatus({
				clientId: "c1",
				online: true,
				supported: true,
				snapshot: null,
				extra: 1,
			}),
		).toThrow();
	});

	it("凭据信息只暴露声明属性与使用状态", () => {
		const parsed = parseTailnetKeyInfo({
			id: "k1",
			name: "test",
			declaredReuse: "reusable",
			declaredExpiresAt: null,
			use: "reserved",
			createdAt: OBSERVED_AT,
		});
		expect(parsed.use).toBe("reserved");
		expect(() =>
			parseTailnetKeyInfo({
				id: "k1",
				name: "test",
				declaredReuse: "reusable",
				declaredExpiresAt: null,
				use: "leaked",
				createdAt: OBSERVED_AT,
			}),
		).toThrow();
		expect(() =>
			parseTailnetKeyInfo({
				id: "k1",
				name: "test",
				declaredReuse: "reusable",
				declaredExpiresAt: null,
				use: "available",
				createdAt: OBSERVED_AT,
				authKey: "fake-secret",
			}),
		).toThrow();
	});

	it("Job 结果携带阶段与摘要且拒绝未知阶段", () => {
		expect(
			parseTailnetJobResult({ stage: "joined", snapshot: snapshot() }).stage,
		).toBe("joined");
		expect(() =>
			parseTailnetJobResult({ stage: "done", snapshot: snapshot() }),
		).toThrow();
	});
});
