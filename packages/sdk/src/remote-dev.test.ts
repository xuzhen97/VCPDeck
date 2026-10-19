import { describe, expect, it, vi } from "vitest";
import { createRemoteDevApi } from "./remote-dev.js";

function fakeClient() {
	const request = vi.fn().mockResolvedValue({ sessionId: "r1" });
	return { request, api: createRemoteDevApi({ request } as never) };
}

describe("createRemoteDevApi", () => {
	it("create 发 POST /api/remote-dev/sessions", async () => {
		const { request, api } = fakeClient();
		await api.create({
			clientId: "c1",
			agentPlacementId: "p1",
			workspaceRoot: "/repo",
		});
		expect(request).toHaveBeenCalledWith(
			"POST",
			"/api/remote-dev/sessions",
			expect.objectContaining({ clientId: "c1" }),
			undefined,
		);
	});

	it("issueForwardToken 走端口子路径", async () => {
		const { request, api } = fakeClient();
		await api.ports.issueForwardToken("r/1", "p/1");
		expect(request).toHaveBeenCalledWith(
			"POST",
			"/api/remote-dev/sessions/r%2F1/ports/p%2F1/forward-token",
			undefined,
			undefined,
		);
		await api.issueForwardToken("r/1", "p/1");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("create 透传 resumeFromSessionId", async () => {
		const { request, api } = fakeClient();
		await api.create({
			clientId: "c1",
			agentPlacementId: "p1",
			workspaceRoot: "/repo",
			resumeFromSessionId: "rds_old",
		});
		expect(request).toHaveBeenCalledWith(
			"POST",
			"/api/remote-dev/sessions",
			expect.objectContaining({ resumeFromSessionId: "rds_old" }),
			undefined,
		);
	});
});
