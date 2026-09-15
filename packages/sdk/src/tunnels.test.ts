import { describe, expect, it, vi } from "vitest";
import { createTunnelsApi } from "./tunnels.js";

describe("createTunnelsApi", () => {
	it("按固定 REST 路径管理配置和 Session", async () => {
		const request = vi.fn().mockResolvedValue({});
		const api = createTunnelsApi({ request } as never);
		await api.config.get();
		await api.config.update({
			stunUrls: ["stun:turn.example.com:3478"],
			turnUrls: ["turn:turn.example.com:3478"],
			realm: "turn.example.com",
		});
		await api.create({ clientId: "c1", targetPort: 3000 });
		await api.remove("tn_1");
		expect(request.mock.calls).toEqual([
			["GET", "/api/tunnels/config", undefined, undefined],
			["PUT", "/api/tunnels/config", expect.any(Object), undefined],
			["POST", "/api/tunnels", { clientId: "c1", targetPort: 3000 }, undefined],
			["DELETE", "/api/tunnels/tn_1", undefined, undefined],
		]);
	});

	it("remove 对 sessionId 做 URL 编码", async () => {
		const request = vi.fn().mockResolvedValue({ closed: true });
		const api = createTunnelsApi({ request } as never);
		await api.remove("tn/a");
		expect(request).toHaveBeenLastCalledWith("DELETE", "/api/tunnels/tn%2Fa", undefined, undefined);
	});
});
