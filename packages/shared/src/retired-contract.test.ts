import { describe, expect, it } from "vitest";
import { Events, JobType } from "./index.js";

describe("退役的 Pi／session-host 公共契约", () => {
	it("不再声明 Pi 与 session-host 事件", () => {
		const retired = Object.values(Events).filter(
			(value) => value.startsWith("pi:") || value.startsWith("session-host:"),
		);
		expect(retired).toEqual([]);
	});

	it("JobType 不再包含 Agent 专用类型", () => {
		expect(Object.values(JobType)).not.toContain("agent.session");
		expect(Object.values(JobType)).not.toContain("agent.run");
		// 基础 Job 类型保持可用
		expect(Object.values(JobType)).toContain("exec");
		expect(Object.values(JobType)).toContain("file.readText");
	});

	it("模块不再导出 Pi／宿主协议解析器", async () => {
		const mod = (await import("./index.js")) as Record<string, unknown>;
		for (const name of [
			"parsePiCapabilityStatus",
			"parsePiEvent",
			"parsePiRequest",
			"parsePiResponse",
			"parsePiRuntimeSpecV4",
			"parseSessionHostStatusReport",
			"parsePiModelCatalogStatus",
		]) {
			expect(mod).not.toHaveProperty(name);
		}
	});
});
