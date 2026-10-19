import { describe, expect, it, vi } from "vitest";
import type { AcpAdapterEvent } from "@vcpdeck/shared";
import type { AcpHostOptions } from "../acp/acp-host.js";
import { createRemoteDevRuntime } from "./remote-dev-runtime.js";

function makeHost() {
	return {
		start: vi.fn().mockResolvedValue({ sessionId: "acp-1" }),
		prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
		cancel: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
	};
}

function makeRuntime() {
	const events: Array<Record<string, unknown>> = [];
	let options: AcpHostOptions | undefined;
	const host = makeHost();
	const runtime = createRemoteDevRuntime({
		createHost: (next) => {
			options = next;
			return host;
		},
		emit: (event) => events.push(event as unknown as Record<string, unknown>),
		canonicalize: async (root) => root,
	});
	return { runtime, host, events, options: () => options };
}

const createCommand = {
	action: "session.create" as const,
	requestId: "req-1",
	sessionId: "r1",
	agentPlacementId: "p1",
	workspaceRoot: "/repo",
	workspaceRoots: ["/repo"],
	command: "node",
	args: ["agent.mjs"],
	cwd: "/repo",
};

describe("RemoteDevRuntime", () => {
	it("session.create 启动 ACP Host 并回报 generation", async () => {
		const h = makeRuntime();
		const created = await h.runtime.create(createCommand);
		expect(created).toEqual({
			sessionId: "r1",
			generationId: expect.any(String),
			acpSessionId: "acp-1",
		});
		expect(h.host.start).toHaveBeenCalledTimes(1);
		expect(h.options()?.cwd).toBe("/repo");
		expect(h.options()?.resumeSessionId).toBeUndefined();
	});

	it("acpSessionId 存在时透传给 Host 并原样回传", async () => {
		const h = makeRuntime();
		const created = await h.runtime.create({
			...createCommand,
			acpSessionId: "acp-old",
		});
		expect(h.options()?.resumeSessionId).toBe("acp-old");
		expect(created.acpSessionId).toBe("acp-1");
	});

	it("续接启动失败用 RDS_RESUME_FAILED，而非 RDS_AGENT_UNAVAILABLE", async () => {
		const host = {
			start: vi
				.fn()
				.mockRejectedValue(
					Object.assign(new Error("boom"), { code: "ACP_RESUME_FAILED" }),
				),
			prompt: vi.fn(),
			cancel: vi.fn(),
			close: vi.fn().mockResolvedValue(undefined),
		};
		const runtime = createRemoteDevRuntime({
			createHost: () => host,
			emit: () => undefined,
			canonicalize: async (root) => root,
		});
		await expect(
			runtime.create({ ...createCommand, acpSessionId: "acp-old" }),
		).rejects.toMatchObject({ code: "RDS_RESUME_FAILED" });
		await expect(runtime.create(createCommand)).rejects.toMatchObject({
			code: "RDS_AGENT_UNAVAILABLE",
		});
	});

	it("workspace 越界时拒绝启动", async () => {
		const host = makeHost();
		const runtime = createRemoteDevRuntime({
			createHost: () => host,
			emit: () => undefined,
			canonicalize: async () => {
				throw new Error("outside");
			},
		});
		await expect(runtime.create(createCommand)).rejects.toMatchObject({
			code: "RDS_WORKSPACE_INVALID",
		});
		expect(host.start).not.toHaveBeenCalled();
	});

	it("prompt 发出 busy/idle 状态并把 ACP 事件带回", async () => {
		const h = makeRuntime();
		await h.runtime.create(createCommand);
		const opts = h.options();
		opts?.onEvent({
			type: "agent.message.delta",
			messageId: "m1",
			text: "hello",
		} satisfies AcpAdapterEvent);
		await h.runtime.prompt("r1", "do it");
		expect(h.host.prompt).toHaveBeenCalledWith("do it");
		expect(h.events).toContainEqual(
			expect.objectContaining({ type: "agent.event", seq: 1 }),
		);
		expect(h.events).toContainEqual(
			expect.objectContaining({ type: "agent.status", status: "busy" }),
		);
		expect(h.events).toContainEqual(
			expect.objectContaining({ type: "agent.status", status: "idle" }),
		);
	});

	it("permission 等待链由 runtime.permission 回答", async () => {
		const h = makeRuntime();
		await h.runtime.create(createCommand);
		const opts = h.options();
		const permission = opts?.onPermission?.({
			requestId: "perm-1",
			sessionId: "acp-1",
			toolCallId: "tool-1",
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		});
		await Promise.resolve();
		expect(h.events).toContainEqual(
			expect.objectContaining({
				type: "agent.event",
				event: expect.objectContaining({
					type: "permission.requested",
					requestId: "perm-1",
				}),
			}),
		);
		h.runtime.permission("r1", "perm-1", {
			outcome: "selected",
			optionId: "allow",
		});
		await expect(permission).resolves.toEqual({
			outcome: "selected",
			optionId: "allow",
		});
	});

	it("close 幂等关闭 Host", async () => {
		const h = makeRuntime();
		await h.runtime.create(createCommand);
		await h.runtime.close("r1", "owner");
		await h.runtime.close("r1", "owner");
		expect(h.host.close).toHaveBeenCalledTimes(1);
	});
});

describe("listSessions（注册时上报存活会话）", () => {
	it("只报告仍在运行的会话，关闭后不再上报", async () => {
		const { runtime } = makeRuntime();
		expect(runtime.listSessions()).toEqual([]);

		const created = await runtime.create(createCommand);
		expect(runtime.listSessions()).toEqual([
			{ sessionId: created.sessionId, generationId: created.generationId },
		]);

		await runtime.close(created.sessionId);
		expect(runtime.listSessions()).toEqual([]);
	});
});