import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@vcpdeck/shared";
import { A2aController } from "./a2a.controller.js";

const ACTOR: ActorContext = {
	identityId: "i1",
	displayName: "Admin",
	isAdmin: true,
	credentialId: null,
	sessionId: null,
	source: "cli",
	requestId: "req-1",
};

function makeController() {
	const service = {
		rpc: vi.fn(async (request: { id: string | number }) => ({
			jsonrpc: "2.0",
			id: request.id,
			result: {},
		})),
		agentCard: vi.fn(async () => ({ name: "hub" })),
	};
	return { controller: new A2aController(service as never), service };
}

describe("A2aController", () => {
	it("未知方法返回 JSON-RPC -32601", async () => {
		const { controller } = makeController();
		const response = await controller.rpc(
			{ jsonrpc: "2.0", id: 1, method: "Unknown", params: {} },
			ACTOR,
		);
		expect(response).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32601 },
		});
	});

	it("非法 params 返回 -32600 且不回显敏感字段", async () => {
		const { controller } = makeController();
		const response = await controller.rpc(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "SendMessage",
				params: {
					message: { messageId: "m1", role: "user", parts: [{ text: "x" }] },
					metadata: { command: "rm -rf /" },
				},
			},
			ACTOR,
		);
		expect(response).toMatchObject({
			jsonrpc: "2.0",
			id: 2,
			error: { code: -32600 },
		});
		if ("error" in response) {
			expect(response.error.message).not.toContain("rm -rf");
		}
	});
});
