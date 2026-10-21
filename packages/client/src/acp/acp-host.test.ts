import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AcpAdapterEvent } from "@vcpdeck/shared";
import { createAcpHost } from "./acp-host.js";

const fixture = resolve("src/acp/fixtures/fake-agent.mjs");

function makeHost(events: AcpAdapterEvent[]) {
	return createAcpHost({
		command: process.execPath,
		args: [fixture],
		cwd: process.cwd(),
		onEvent: (event) => events.push(event),
		onPermission: async () => ({
			outcome: "selected",
			optionId: "allow-once",
		}),
		onExit: () => undefined,
	});
}

describe("createAcpHost", () => {
	it("完成 initialize/session-new/prompt/update/permission", async () => {
		const events: AcpAdapterEvent[] = [];
		const host = makeHost(events);
		try {
			await expect(host.start()).resolves.toMatchObject({ sessionId: "s1" });
			await expect(host.prompt("first")).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "agent.message.delta",
						text: "working",
					}),
					expect.objectContaining({ type: "tool.started", toolCallId: "call-1" }),
				]),
			);
		} finally {
			await host.close();
		}
	});

	it("未知 sessionUpdate 被忽略而不杀会话", async () => {
		const events: AcpAdapterEvent[] = [];
		const host = makeHost(events);
		try {
			await host.start();
			await expect(host.prompt("unknown")).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(events.some((event) => event.type === "agent.message.delta")).toBe(
				true,
			);
		} finally {
			await host.close();
		}
	});

	it("cancel 让当前 prompt 以 cancelled 结束", async () => {
		const events: AcpAdapterEvent[] = [];
		const host = makeHost(events);
		try {
			await host.start();
			const prompt = host.prompt("slow");
			await new Promise((resolve) => setTimeout(resolve, 50));
			await host.cancel();
			await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
		} finally {
			await host.close();
		}
	});

	it("resumeSessionId 存在时走 session/resume 并沿用该 id", async () => {
		const events: AcpAdapterEvent[] = [];
		const host = createAcpHost({
			command: process.execPath,
			args: [fixture],
			cwd: process.cwd(),
			resumeSessionId: "resumed-1",
			onEvent: (event) => events.push(event),
			onPermission: async () => ({
				outcome: "selected",
				optionId: "allow-once",
			}),
			onExit: () => undefined,
		});
		try {
			await expect(host.start()).resolves.toMatchObject({
				sessionId: "resumed-1",
			});
			await expect(host.prompt("first")).resolves.toEqual({
				stopReason: "end_turn",
			});
		} finally {
			await host.close();
		}
	});

	it("close 会发 session/close 并结束子进程（避免 agent 常驻）", async () => {
		let exited = false;
		const host = createAcpHost({
			command: process.execPath,
			args: [fixture],
			cwd: process.cwd(),
			onEvent: () => undefined,
			onExit: () => {
				exited = true;
			},
		});
		await host.start();
		await host.close();
		// 关闭后 host 不可再用
		await expect(host.prompt("after-close")).rejects.toMatchObject({
			code: "ACP_NOT_STARTED",
		});
		// 子进程应被 kill：等待退出事件落地
		for (let i = 0; i < 40 && !exited; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(exited).toBe(true);
	});

	it("resume 失败时抛出 ACP_RESUME_FAILED", async () => {
		const host = createAcpHost({
			command: process.execPath,
			args: [fixture],
			cwd: process.cwd(),
			resumeSessionId: "missing-session",
			onEvent: () => undefined,
			onExit: () => undefined,
		});
		await expect(host.start()).rejects.toMatchObject({
			code: "ACP_RESUME_FAILED",
		});
	});
});
