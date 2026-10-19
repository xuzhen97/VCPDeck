import { describe, expect, it, vi } from "vitest";
import { makeRemoteDevService, ACTOR } from "./test-helpers.js";

describe("RemoteDevService", () => {
	it("Client 离线时不创建 DB 记录", async () => {
		const h = makeRemoteDevService({ clientOnline: false });
		await expect(
			h.service.create(
				{
					clientId: "c1",
					agentPlacementId: "p1",
					workspaceRoot: "/repo",
				},
				ACTOR,
			),
		).rejects.toMatchObject({ code: "RDS_CLIENT_OFFLINE" });
		expect(h.sessions.size).toBe(0);
	});

	it("Client 未声明 remote-dev 时拒绝", async () => {
		const h = makeRemoteDevService({ capabilities: ["acp"] });
		await expect(
			h.service.create(
				{
					clientId: "c1",
					agentPlacementId: "p1",
					workspaceRoot: "/repo",
				},
				ACTOR,
			),
		).rejects.toMatchObject({ code: "RDS_UNSUPPORTED_CLIENT" });
	});

	it("workspace 越出 placement roots 时拒绝", async () => {
		const h = makeRemoteDevService();
		await expect(
			h.service.create(
				{
					clientId: "c1",
					agentPlacementId: "p1",
					workspaceRoot: "/etc",
				},
				ACTOR,
			),
		).rejects.toMatchObject({ code: "RDS_WORKSPACE_INVALID" });
	});

	it("创建成功后置 active，并下发受控 placement", async () => {
		const h = makeRemoteDevService();
		const session = await h.service.create(
			{
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "/repo/src",
			},
			ACTOR,
		);
		expect(session.state).toBe("active");
		expect(session.generationId).toBe("gen-1");
		expect(h.sent[0]).toMatchObject({
			action: "session.create",
			command: "node",
			args: ["fake-agent.mjs"],
			cwd: "/repo",
			workspaceRoots: ["/repo"],
		});
	});

	it("关闭 RDS 会关闭 parentSessionId 关联的终端与端口", async () => {
		const h = makeRemoteDevService();
		const session = await h.service.create(
			{
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "/repo",
			},
			ACTOR,
		);
		const closeByParent = vi.spyOn(h.terminals, "closeByParent");
		await h.service.openPort(session.sessionId, { remotePort: 3000 }, ACTOR);
		const closed = await h.service.close(session.sessionId, ACTOR);
		expect(closed.state).toBe("closed");
		expect(closeByParent).toHaveBeenCalledWith(session.sessionId, ACTOR);
		expect(h.ports.size).toBe(1);
		expect([...h.ports.values()][0]?.status).toBe("closed");
	});

	it("Client 不 ack 时创建超时并标记 failed/partial", async () => {
		const h = makeRemoteDevService({ autoAck: false, createTimeoutMs: 5 });
		await expect(
			h.service.create(
				{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
				ACTOR,
			),
		).rejects.toMatchObject({ code: "RDS_COMMAND_FAILED" });
		const row = [...h.sessions.values()][0];
		expect(row).toMatchObject({ state: "failed", cleanupStatus: "partial" });
	});

	it("Client 在 ack 前结束会话时不会被覆盖成 active", async () => {
		const h = makeRemoteDevService({ autoAck: false, createTimeoutMs: 100 });
		const pending = h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const id = [...h.sessions.keys()][0]!;
		await h.service.handleClientEvent("socket-1", {
			type: "session.ended",
			sessionId: id,
			generationId: "gen-1",
			reason: "error",
		});
		const command = h.sent[0]!;
		await h.service.handleCommandResult("socket-1", {
			requestId: command.requestId,
			ok: true,
			sessionId: id,
			generationId: "gen-1",
		});
		await expect(pending).rejects.toMatchObject({ code: "RDS_COMMAND_FAILED" });
		expect(h.sessions.get(id)?.state).toBe("failed");
		expect(h.sessions.get(id)?.generationId).toBe("");
	});

	it("每 session 最多 8 个打开端口", async () => {
		const h = makeRemoteDevService();
		const session = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		for (let index = 0; index < 8; index += 1) {
			await h.service.openPort(
				session.sessionId,
				{ remotePort: 3000 + index },
				ACTOR,
			);
		}
		await expect(
			h.service.openPort(session.sessionId, { remotePort: 4000 }, ACTOR),
		).rejects.toMatchObject({ code: "RDS_LIMIT_EXCEEDED" });
	});

	it("关闭后可重新打开同一 remotePort，不触发唯一键冲突", async () => {
		const h = makeRemoteDevService();
		const session = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		const first = await h.service.openPort(
			session.sessionId,
			{ remotePort: 3000 },
			ACTOR,
		);
		await h.service.closePort(session.sessionId, first.portId, ACTOR);
		const reopened = await h.service.openPort(
			session.sessionId,
			{ remotePort: 3000, label: "again" },
			ACTOR,
		);
		expect(reopened.portId).toBe(first.portId);
		expect(reopened.status).toBe("open");
		expect(reopened.label).toBe("again");
		expect(h.ports.size).toBe(1);
	});

	it("非 owner 不能 prompt；错误 generation 的事件不投影", async () => {
		const h = makeRemoteDevService();
		const session = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		const other = { ...ACTOR, identityId: "id-2" };
		await expect(
			h.service.prompt(session.sessionId, "hello", other),
		).rejects.toMatchObject({ code: "RDS_OPERATOR_REQUIRED" });

		const forwarded: unknown[] = [];
		h.service.bindBrowserEmitter((_id, event) => forwarded.push(event));
		await h.service.handleClientEvent("socket-1", {
			type: "agent.event",
			sessionId: session.sessionId,
			generationId: "stale",
			seq: 1,
			event: { type: "agent.message.delta", messageId: "m1", text: "stale" },
		});
		expect(forwarded).toEqual([]);
		await h.service.handleClientEvent("other-socket", {
			type: "agent.event",
			sessionId: session.sessionId,
			generationId: session.generationId,
			seq: 2,
			event: { type: "agent.message.delta", messageId: "m2", text: "wrong socket" },
		});
		expect(forwarded).toEqual([]);
		await h.service.handleClientEvent("socket-1", {
			type: "agent.event",
			sessionId: session.sessionId,
			generationId: session.generationId,
			seq: 3,
			event: { type: "agent.message.delta", messageId: "m3", text: "ok" },
		});
		expect(forwarded).toHaveLength(1);
	});

	it("续接：同 client/placement/workspace 且源会话终态时注入 acpSessionId", async () => {
		const h = makeRemoteDevService();
		const source = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		const row = h.sessions.get(source.sessionId);
		if (!row) throw new Error("source session missing");
		row.state = "closed";
		row.acpSessionId = "acp-old";

		const resumed = await h.service.create(
			{
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "/repo",
				resumeFromSessionId: source.sessionId,
			},
			ACTOR,
		);
		expect(h.sent[1]).toMatchObject({
			action: "session.create",
			acpSessionId: "acp-old",
		});
		expect(resumed.acpSessionId).toBe("acp-old");
		expect(resumed.state).toBe("active");
	});

	it("续接：非终态 / 无上下文 / 归属不符分别拒绝", async () => {
		const cases: Array<{
			patch: Partial<{
				state: string;
				acpSessionId: string | null;
				clientId: string;
				workspaceRoot: string;
			}>;
			code: string;
		}> = [
			{
				patch: { state: "active", acpSessionId: "acp-old" },
				code: "RDS_RESUME_NOT_ALLOWED",
			},
			{
				patch: { state: "closed", acpSessionId: null },
				code: "RDS_RESUME_UNAVAILABLE",
			},
			{
				patch: { state: "closed", acpSessionId: "acp-old", clientId: "c2" },
				code: "RDS_RESUME_MISMATCH",
			},
			{
				patch: {
					state: "closed",
					acpSessionId: "acp-old",
					workspaceRoot: "/repo/other",
				},
				code: "RDS_RESUME_MISMATCH",
			},
		];
		for (const item of cases) {
			const h = makeRemoteDevService();
			const source = await h.service.create(
				{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
				ACTOR,
			);
			const row = h.sessions.get(source.sessionId);
			if (!row) throw new Error("source session missing");
			Object.assign(row, item.patch);
			await expect(
				h.service.create(
					{
						clientId: "c1",
						agentPlacementId: "p1",
						workspaceRoot: "/repo",
						resumeFromSessionId: source.sessionId,
					},
					ACTOR,
				),
			).rejects.toMatchObject({ code: item.code });
		}
	});

	it("上报 acp-session：generation 与 socket 都匹配才落库", async () => {
		const h = makeRemoteDevService();
		const session = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		await h.service.handleAcpSessionReport("socket-1", {
			sessionId: session.sessionId,
			generationId: "gen-2",
			acpSessionId: "acp-x",
		});
		expect(h.sessions.get(session.sessionId)?.acpSessionId).toBeNull();

		await h.service.handleAcpSessionReport("socket-9", {
			sessionId: session.sessionId,
			generationId: "gen-1",
			acpSessionId: "acp-x",
		});
		expect(h.sessions.get(session.sessionId)?.acpSessionId).toBeNull();

		await h.service.handleAcpSessionReport("socket-1", {
			sessionId: session.sessionId,
			generationId: "gen-1",
			acpSessionId: "acp-x",
		});
		expect(h.sessions.get(session.sessionId)?.acpSessionId).toBe("acp-x");
	});

	it("上报 acp-session：结果尚未落库（generationId 仍为空）时也接受", async () => {
		const h = makeRemoteDevService();
		const session = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		const row = h.sessions.get(session.sessionId);
		if (!row) throw new Error("session missing");
		// 真实时序：Client 先发 rds:acp-session，再发 rds:command-result，
		// 因此上报到达时行上的 generationId 还是空串。
		row.generationId = "";
		row.acpSessionId = null;

		await h.service.handleAcpSessionReport("socket-1", {
			sessionId: session.sessionId,
			generationId: "gen-1",
			acpSessionId: "acp-early",
		});
		expect(h.sessions.get(session.sessionId)?.acpSessionId).toBe("acp-early");
	});

	it("上报 acp-session：socket 不属于该会话的 Client 时丢弃", async () => {
		const h = makeRemoteDevService();
		const session = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		const row = h.sessions.get(session.sessionId);
		if (!row) throw new Error("session missing");
		row.clientId = "c2";

		await h.service.handleAcpSessionReport("socket-1", {
			sessionId: session.sessionId,
			generationId: "gen-1",
			acpSessionId: "acp-x",
		});
		expect(h.sessions.get(session.sessionId)?.acpSessionId).toBeNull();
	});

	it("续接：非 owner 不能续接他人会话", async () => {
		const h = makeRemoteDevService();
		const source = await h.service.create(
			{ clientId: "c1", agentPlacementId: "p1", workspaceRoot: "/repo" },
			ACTOR,
		);
		const row = h.sessions.get(source.sessionId);
		if (!row) throw new Error("source session missing");
		row.state = "closed";
		row.acpSessionId = "acp-old";
		row.ownerIdentityId = "id-other";

		await expect(
			h.service.create(
				{
					clientId: "c1",
					agentPlacementId: "p1",
					workspaceRoot: "/repo",
					resumeFromSessionId: source.sessionId,
				},
				ACTOR,
			),
		).rejects.toMatchObject({ code: "RDS_OPERATOR_REQUIRED" });
	});
});
