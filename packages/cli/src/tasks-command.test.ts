import { describe, expect, it, vi } from "vitest";
import { runTasksCommand } from "./tasks-command.js";

function fakeSdk() {
	const sendMessage = vi.fn().mockResolvedValue({
		id: "task-1",
		status: { state: "TASK_STATE_WORKING" },
	});
	const get = vi.fn().mockResolvedValue({
		id: "task-1",
		status: { state: "TASK_STATE_COMPLETED" },
	});
	const list = vi.fn().mockResolvedValue({
		tasks: [],
		nextPageToken: "",
		pageSize: 20,
		totalSize: 0,
	});
	return {
		sendMessage,
		get,
		list,
		sdk: { tasks: { sendMessage, get, list } } as never,
	};
}

describe("tasks command", () => {
	it("send 把 agent/intent/message 映射为 A2A SendMessage", async () => {
		const { sdk, sendMessage } = fakeSdk();
		const log = vi.fn();
		await runTasksCommand(
			"send",
			[
				"--agent=reviewer",
				"--intent=review",
				"--message=please check",
				"--accept=tests pass",
				"--json",
			],
			{ sdk, log },
		);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: {
					agentId: "reviewer",
					intent: "review",
					acceptanceCriteria: ["tests pass"],
				},
			}),
		);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("TASK_STATE_WORKING"));
	});

	it("缺 --agent 时输出用法而不调用 SDK", async () => {
		const { sdk, sendMessage } = fakeSdk();
		await expect(
			runTasksCommand("send", ["--intent=review", "--message=x"], {
				sdk,
				log: vi.fn(),
			}),
		).rejects.toThrow(/Tasks 命令/);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("无子命令输出帮助", async () => {
		const { sdk, sendMessage } = fakeSdk();
		const log = vi.fn();
		await runTasksCommand(undefined, [], { sdk, log });
		expect(log).toHaveBeenCalledWith(expect.stringContaining("A2A v1.0"));
		expect(sendMessage).not.toHaveBeenCalled();
	});
});
