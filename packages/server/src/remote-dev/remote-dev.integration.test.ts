import { describe, expect, it } from "vitest";
import { RdsFrameDecoder, encodeRdsFrame, encodeRdsOpenPayload } from "@vcpdeck/shared";
import { RemoteDevPortService } from "./remote-dev-port.service.js";
import { RdsRelay } from "./rds-relay.js";
import { ACTOR, makeRemoteDevService } from "./test-helpers.js";

describe("RDS 集成回路", () => {
	it("创建 → agent 事件 → 端口 token/OPEN → 关闭后无残留", async () => {
		const h = makeRemoteDevService();
		const forwarded: Array<Record<string, unknown>> = [];
		h.service.bindBrowserEmitter((_sessionId, event) =>
			forwarded.push({ ...event }),
		);
		const session = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		await h.service.handleClientEvent("socket-1", {
			type: "agent.event",
			sessionId: session.sessionId,
			generationId: session.generationId,
			seq: 1,
			event: { type: "agent.message.delta", messageId: "m1", text: "hello" },
		});
		expect(forwarded).toContainEqual(
			expect.objectContaining({
				type: "agent.event",
				event: expect.objectContaining({ text: "hello" }),
			}),
		);

		const port = await h.service.openPort(
			session.sessionId,
			{ remotePort: 3000 },
			ACTOR,
		);
		const tokens = RemoteDevPortService.withDeps({ now: () => 1_000 });
		const token = await tokens.issueForwardToken(
			session.sessionId,
			port.portId,
			ACTOR,
		);
		expect(
			tokens.validateToken(session.sessionId, port.portId, token.token, 1_000),
		).toBe(true);

		const relay = new RdsRelay();
		relay.bindClient(session.sessionId, "client-socket");
		relay.bindCli(session.sessionId, "cli-socket", 7);
		const openFrame = {
			type: "OPEN" as const,
			streamId: 7,
			payload: encodeRdsOpenPayload({ remotePort: 3000 }),
		};
		expect(relay.toClient(session.sessionId, openFrame)?.socketId).toBe(
			"client-socket",
		);
		const decoded = new RdsFrameDecoder().push(encodeRdsFrame(openFrame));
		expect(decoded[0]).toEqual(expect.objectContaining({ type: "OPEN", streamId: 7 }));

		await h.service.close(session.sessionId, ACTOR);
		expect([...h.ports.values()].every((item) => item.status === "closed")).toBe(
			true,
		);
	});
});
