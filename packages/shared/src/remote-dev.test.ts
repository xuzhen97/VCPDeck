import { describe, expect, it } from "vitest";
import {
	parseRemoteDevAcpSessionReport,
	parseRemoteDevBrowserAttach,
	parseRemoteDevBrowserPermission,
	parseRemoteDevBrowserPortClose,
	parseRemoteDevBrowserPortOpen,
	parseRemoteDevBrowserPrompt,
	parseRemoteDevBrowserResync,
	parseRemoteDevClientCommand,
	parseRemoteDevClientEvent,
	parseRemoteDevPortCreateRequest,
	parseRemoteDevSessionCreateRequest,
	parseRemoteDevTranscriptPayload,
} from "./remote-dev.js";

describe("Remote Dev Session 契约", () => {
	it("接受最小创建请求并拒绝空 workspace", () => {
		expect(
			parseRemoteDevSessionCreateRequest({
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "/repo",
			}),
		).toMatchObject({
			clientId: "c1",
			agentPlacementId: "p1",
			workspaceRoot: "/repo",
		});
		expect(() =>
			parseRemoteDevSessionCreateRequest({
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "",
			}),
		).toThrow();
	});

	it("拒绝未知字段与超长 label", () => {
		expect(() =>
			parseRemoteDevSessionCreateRequest({
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "/repo",
				extra: true,
			}),
		).toThrow();
		expect(() =>
			parseRemoteDevSessionCreateRequest({
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "/repo",
				label: "x".repeat(81),
			}),
		).toThrow();
	});

	it("端口只能是 1024-65535 的整数", () => {
		expect(parseRemoteDevPortCreateRequest({ remotePort: 3000 })).toMatchObject({
			remotePort: 3000,
		});
		expect(() => parseRemoteDevPortCreateRequest({ remotePort: 80 })).toThrow();
		expect(() =>
			parseRemoteDevPortCreateRequest({ remotePort: 3000.5 }),
		).toThrow();
		expect(() =>
			parseRemoteDevPortCreateRequest({ remotePort: 65536 }),
		).toThrow();
	});

	it("浏览器请求严格校验，unknown 字段拒绝", () => {
		expect(parseRemoteDevBrowserAttach({ sessionId: "r1" })).toEqual({
			sessionId: "r1",
		});
		expect(parseRemoteDevBrowserPrompt({ sessionId: "r1", text: "hi" })).toEqual({
			sessionId: "r1",
			text: "hi",
		});
		expect(() =>
			parseRemoteDevBrowserPrompt({ sessionId: "r1", text: "hi", extra: 1 }),
		).toThrow();
		expect(
			parseRemoteDevBrowserPermission({
				sessionId: "r1",
				requestId: "perm-1",
				optionId: "allow-once",
			}),
		).toEqual({
			sessionId: "r1",
			requestId: "perm-1",
			optionId: "allow-once",
		});
		expect(
			parseRemoteDevBrowserPermission({
				sessionId: "r1",
				requestId: "perm-1",
			}),
		).toEqual({ sessionId: "r1", requestId: "perm-1" });
		expect(
			parseRemoteDevBrowserPortOpen({ sessionId: "r1", remotePort: 3000 }),
		).toEqual({ sessionId: "r1", remotePort: 3000 });
		expect(
			parseRemoteDevBrowserPortClose({ sessionId: "r1", portId: "p1" }),
		).toEqual({ sessionId: "r1", portId: "p1" });
		expect(parseRemoteDevBrowserResync({ sessionId: "r1" })).toEqual({
			sessionId: "r1",
		});
	});

	it("Client 事件内层 ACP 载荷也严格校验", () => {
		const envelope = {
			type: "agent.event",
			sessionId: "r1",
			generationId: "g1",
			seq: 1,
			event: {
				type: "permission.requested",
				requestId: "perm-1",
				toolCallId: "t1",
				title: "Run",
				options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
			},
		};
		expect(parseRemoteDevClientEvent(envelope)).toMatchObject({
			type: "agent.event",
			event: { type: "permission.requested", requestId: "perm-1" },
		});
		expect(() =>
			parseRemoteDevClientEvent({
				...envelope,
				event: { ...envelope.event, options: "not-an-array" },
			}),
		).toThrow();
		expect(() =>
			parseRemoteDevClientEvent({
				...envelope,
				event: { ...envelope.event, extra: true },
			}),
		).toThrow();
		expect(() =>
			parseRemoteDevClientEvent({
				...envelope,
				event: { type: "session.ended", reason: "ghost" },
			}),
		).toThrow();
	});
});

describe("RDS 续接协议", () => {
	const createCommand = {
		action: "session.create",
		requestId: "r1",
		sessionId: "rds_1",
		agentPlacementId: "p1",
		workspaceRoot: "/repo",
		workspaceRoots: ["/repo"],
		command: "dsh",
		args: ["--profile", "acp"],
		cwd: "/repo",
	};

	it("session.create 接受可选 acpSessionId，缺省时不出现该字段", () => {
		expect(parseRemoteDevClientCommand(createCommand)).not.toHaveProperty(
			"acpSessionId",
		);
		expect(
			parseRemoteDevClientCommand({ ...createCommand, acpSessionId: "s1" }),
		).toMatchObject({ acpSessionId: "s1" });
		expect(() =>
			parseRemoteDevClientCommand({ ...createCommand, acpSessionId: 1 }),
		).toThrow();
		expect(() =>
			parseRemoteDevClientCommand({ ...createCommand, unexpected: true }),
		).toThrow();
	});

	it("创建请求接受可选 resumeFromSessionId，并继续拒绝未知字段", () => {
		const base = {
			clientId: "c1",
			agentPlacementId: "p1",
			workspaceRoot: "/repo",
		};
		expect(parseRemoteDevSessionCreateRequest(base)).not.toHaveProperty(
			"resumeFromSessionId",
		);
		expect(
			parseRemoteDevSessionCreateRequest({
				...base,
				resumeFromSessionId: "rds_0",
			}),
		).toMatchObject({ resumeFromSessionId: "rds_0" });
		expect(() =>
			parseRemoteDevSessionCreateRequest({ ...base, resumeFromSessionId: 1 }),
		).toThrow();
	});

	it("acp-session 上报严格校验", () => {
		expect(
			parseRemoteDevAcpSessionReport({
				sessionId: "rds_1",
				generationId: "g1",
				acpSessionId: "s1",
			}),
		).toEqual({ sessionId: "rds_1", generationId: "g1", acpSessionId: "s1" });
		expect(() =>
			parseRemoteDevAcpSessionReport({
				sessionId: "rds_1",
				generationId: "g1",
			}),
		).toThrow();
		expect(() =>
			parseRemoteDevAcpSessionReport({
				sessionId: "rds_1",
				generationId: "g1",
				acpSessionId: "s1",
				extra: 1,
			}),
		).toThrow();
	});
});

describe("rds:transcript 回放负载", () => {
	it("解析 prompt 与 agent 事件两种条目", () => {
		const payload = parseRemoteDevTranscriptPayload({
			sessionId: "rds_1",
			truncated: true,
			entries: [
				{ seq: 1, at: "2026-10-19T00:00:00.000Z", kind: "prompt", text: "你好" },
				{
					seq: 2,
					at: "2026-10-19T00:00:01.000Z",
					kind: "event",
					event: { type: "agent.message.delta", messageId: "m1", text: "在" },
				},
			],
		});
		expect(payload.entries).toHaveLength(2);
		expect(payload.entries[0]).toMatchObject({ kind: "prompt", text: "你好" });
		expect(payload.truncated).toBe(true);
	});

	it("拒绝未知 kind 与未知字段", () => {
		expect(() =>
			parseRemoteDevTranscriptPayload({
				sessionId: "rds_1",
				truncated: false,
				entries: [{ seq: 1, at: "now", kind: "system" }],
			}),
		).toThrow();
		expect(() =>
			parseRemoteDevTranscriptPayload({
				sessionId: "rds_1",
				truncated: false,
				entries: [
					{ seq: 1, at: "now", kind: "prompt", text: "x", extra: 1 },
				],
			}),
		).toThrow();
	});
});