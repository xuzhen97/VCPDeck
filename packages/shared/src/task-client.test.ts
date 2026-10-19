import { describe, expect, it } from "vitest";
import {
	parseTaskClientCommand,
	parseTaskClientEvent,
	TaskClientProtocolError,
} from "./task-client.js";

describe("parseTaskClientCommand", () => {
	it("接受 start 并保留 args/cwd", () => {
		expect(
			parseTaskClientCommand({
				requestId: "r1",
				action: "start",
				taskId: "t1",
				attemptId: "a1",
				command: "dsh",
				args: ["--profile", "acp"],
				cwd: "/repo",
				prompt: "hello",
			}),
		).toMatchObject({ action: "start", command: "dsh", cwd: "/repo" });
	});

	it("拒绝未知 action", () => {
		expect(() =>
			parseTaskClientCommand({
				requestId: "r1",
				action: "shell",
				taskId: "t1",
				attemptId: "a1",
			}),
		).toThrow(TaskClientProtocolError);
	});

	it("接受 selected permission outcome", () => {
		expect(
			parseTaskClientCommand({
				requestId: "r1",
				action: "permission",
				taskId: "t1",
				attemptId: "a1",
				permissionRequestId: "p1",
				outcome: { outcome: "selected", optionId: "allow-once" },
			}),
		).toMatchObject({
			action: "permission",
			outcome: { outcome: "selected", optionId: "allow-once" },
		});
	});
});

describe("parseTaskClientEvent", () => {
	it("校验信封并保留 event", () => {
		expect(
			parseTaskClientEvent({
				taskId: "t1",
				attemptId: "a1",
				seq: 1,
				event: { type: "agent.thought.delta", text: "thinking" },
			}),
		).toMatchObject({ seq: 1, event: { type: "agent.thought.delta" } });
	});
});
