import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";
import { VcpDeckClient } from "./client.js";

describe("退役的专用 Agent API", () => {
	it("不再导出 Pi／session-host 工厂与协议类型", () => {
		expect(sdk).not.toHaveProperty("createPiApi");
		expect(sdk).not.toHaveProperty("createSessionHostApi");
	});

	it("客户端实例不再挂载 pi／sessionHost 域", () => {
		const client = new VcpDeckClient({
			baseUrl: "http://localhost:3001",
			auth: { type: "bearer", token: "test-token" },
		});
		expect(client).not.toHaveProperty("pi");
		expect(client).not.toHaveProperty("sessionHost");
		// 基础能力域保持可用
		for (const domain of ["jobs", "files", "clients", "terminals", "frp", "storage", "gitSsh", "releases"]) {
			expect(client).toHaveProperty(domain);
		}
	});
});
