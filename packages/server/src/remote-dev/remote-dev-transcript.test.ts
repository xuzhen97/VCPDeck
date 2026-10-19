import { describe, expect, it } from "vitest";
import type { AcpAdapterEvent, RemoteDevSessionInfo } from "@vcpdeck/shared";
import { ACTOR, makeRemoteDevService } from "./test-helpers.js";

async function activeSession(
	h: ReturnType<typeof makeRemoteDevService>,
): Promise<RemoteDevSessionInfo> {
	return h.service.create(
		{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo/src" },
		ACTOR,
	);
}

function agentEvent(
	session: RemoteDevSessionInfo,
	event: AcpAdapterEvent,
	seq: number,
) {
	return {
		type: "agent.event" as const,
		sessionId: session.sessionId,
		generationId: session.generationId,
		seq,
		event,
	};
}

describe("RDS transcript 落库与回放", () => {
	it("prompt 先于 agent 回复落库", async () => {
		const h = makeRemoteDevService();
		const session = await activeSession(h);

		await h.service.prompt(session.sessionId, "跑一下测试", ACTOR);
		await h.service.handleClientEvent(
			"socket-1",
			agentEvent(
				session,
				{ type: "agent.message.delta", messageId: "m1", text: "好的" },
				2,
			),
		);

		const transcript = await h.service.transcript(session.sessionId);
		expect(transcript.entries.map((entry) => entry.kind)).toEqual([
			"prompt",
			"event",
		]);
		expect(transcript.entries[0]).toMatchObject({
			kind: "prompt",
			text: "跑一下测试",
		});
		expect(transcript.truncated).toBe(false);
	});

	it("prompt 失败时回滚，不留孤儿消息", async () => {
		const h = makeRemoteDevService({ failActions: ["agent.prompt"] });
		const session = await activeSession(h);

		await expect(
			h.service.prompt(session.sessionId, "会失败", ACTOR),
		).rejects.toMatchObject({ code: "RDS_COMMAND_FAILED" });

		const transcript = await h.service.transcript(session.sessionId);
		expect(transcript.entries).toHaveLength(0);
	});

	it("连续的流式增量合并成一条记录", async () => {
		const h = makeRemoteDevService();
		const session = await activeSession(h);

		await h.service.handleClientEvent(
			"socket-1",
			agentEvent(
				session,
				{ type: "agent.message.delta", messageId: "m1", text: "你" },
				1,
			),
		);
		await h.service.handleClientEvent(
			"socket-1",
			agentEvent(
				session,
				{ type: "agent.message.delta", messageId: "m1", text: "好" },
				2,
			),
		);

		const transcript = await h.service.transcript(session.sessionId);
		expect(transcript.entries).toHaveLength(1);
		expect(transcript.entries[0]).toMatchObject({
			kind: "event",
			event: { type: "agent.message.delta", text: "你好" },
		});
	});

	it("工具事件就地更新而不是每次新增一行", async () => {
		const h = makeRemoteDevService();
		const session = await activeSession(h);

		await h.service.handleClientEvent(
			"socket-1",
			agentEvent(
				session,
				{ type: "tool.started", toolCallId: "t1", title: "pnpm test" },
				1,
			),
		);
		await h.service.handleClientEvent(
			"socket-1",
			agentEvent(
				session,
				{ type: "tool.updated", toolCallId: "t1", status: "completed" },
				2,
			),
		);

		const transcript = await h.service.transcript(session.sessionId);
		expect(transcript.entries).toHaveLength(1);
		expect(transcript.entries[0]?.kind === "event" && transcript.entries[0].event)
			.toMatchObject({
				type: "tool.started",
				title: "pnpm test",
				status: "completed",
			});
	});

	it("超出保留上限时丢弃最早的记录并标记 truncated", async () => {
		const h = makeRemoteDevService();
		const session = await activeSession(h);

		// 上限 400：写满 +2 条后最早的两条应被裁掉
		for (let seq = 1; seq <= 402; seq += 1) {
			await h.service.handleClientEvent(
				"socket-1",
				agentEvent(
					session,
					// 每条都是不同的 messageId，不会与上一条合并
					{ type: "agent.message.delta", messageId: `m-${seq}`, text: `行 ${seq}` },
					seq,
				),
			);
		}

		const transcript = await h.service.transcript(session.sessionId);
		expect(transcript.entries.length).toBeLessThanOrEqual(400);
		expect(transcript.truncated).toBe(true);
	});
});

describe("RDS 会话与 Client 存活对账", () => {
	it("Client 离线先把会话降级为 disconnected", async () => {
		const h = makeRemoteDevService();
		const session = await activeSession(h);

		await h.service.handleClientOffline("c1");

		expect(h.sessions.get(session.sessionId)?.state).toBe("disconnected");
	});

	it("Client 重启后上报空数组 → 遗留会话收敛为 interrupted 并可续接", async () => {
		const h = makeRemoteDevService();
		const session = await activeSession(h);
		await h.service.handleClientOffline("c1");

		await h.service.reconcileClientSessions("c1", []);

		const row = h.sessions.get(session.sessionId);
		expect(row?.state).toBe("interrupted");
		expect(row?.agentStatus).toBe("exited");
		expect(row?.closeReason).toBe("client-restarted");
	});

	it("Client 重新连上报同一 generation → 会话恢复为 active", async () => {
		const h = makeRemoteDevService();
		const session = await activeSession(h);
		await h.service.handleClientOffline("c1");

		await h.service.reconcileClientSessions("c1", [
			{ sessionId: session.sessionId, generationId: session.generationId },
		]);

		expect(h.sessions.get(session.sessionId)?.state).toBe("active");
	});

	it("旧 Client 未上报时不动任何会话", async () => {
		const h = makeRemoteDevService();
		const session = await activeSession(h);
		await h.service.handleClientOffline("c1");

		await h.service.reconcileClientSessions("c1", undefined);

		// 没有权威信息就不能把别人的会话判死
		expect(h.sessions.get(session.sessionId)?.state).toBe("disconnected");
	});
});
