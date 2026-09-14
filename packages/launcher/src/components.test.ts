import { describe, expect, it } from "vitest";
import { createChildProcessComponent } from "./components.js";

describe("createChildProcessComponent", () => {
	it("rejects start when the binary cannot be spawned", async () => {
		// 二进制缺失时 start 必须失败：否则 Supervisor 会把从未启动的组件当成
		// running，也就不会回滚已经启动的其它组件。
		const component = createChildProcessComponent({
			name: "desktop-host",
			command: "definitely-not-a-real-binary-vcpdeck",
		});
		await expect(component.start()).rejects.toThrow();
	});

	it("reports not-running before start and after stop", async () => {
		const component = createChildProcessComponent({
			name: "worker",
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
		});
		// 未启动时不得报告健康。
		expect(await component.check()).toContain("未运行");
		await component.start();
		expect(await component.check()).toBeNull();
		await component.stop();
		expect(await component.check()).toContain("未运行");
	});

	it("stop is idempotent", async () => {
		const component = createChildProcessComponent({
			name: "worker",
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
		});
		await component.start();
		await component.stop();
		await expect(component.stop()).resolves.toBeUndefined();
	});
});
