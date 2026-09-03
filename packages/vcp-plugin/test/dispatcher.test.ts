import { describe, it, expect, vi } from "vitest";
import { dispatchCommand } from "../src/dispatcher.js";
import { parseEnvFile } from "../src/config.js";

describe("VCPDeckBridge Config Parser", () => {
	it("should parse env file correctly", () => {
		const raw = `
# Comment
SERVER_URL=http://localhost:3000
API_TOKEN="tok_12345"
REQUEST_TIMEOUT_MS=15000
`;
		const parsed = parseEnvFile(raw);
		expect(parsed.SERVER_URL).toBe("http://localhost:3000");
		expect(parsed.API_TOKEN).toBe("tok_12345");
		expect(parsed.REQUEST_TIMEOUT_MS).toBe("15000");
	});
});

describe("VCPDeckBridge Dispatcher", () => {
	const mockClient: any = {
		clients: {
			list: vi.fn().mockResolvedValue([{ clientId: "c1", name: "node-1" }]),
		},
		jobs: {
			create: vi.fn().mockResolvedValue({ jobId: "job-1", status: "pending" }),
			list: vi.fn().mockResolvedValue({ total: 1, page: 1, totalPages: 1, data: [] }),
			output: vi.fn().mockResolvedValue({ jobId: "job-1", output: "hello stdout" }),
		},
		files: {
			roots: vi.fn().mockResolvedValue(["/"]),
			readText: vi.fn().mockResolvedValue("file content"),
		},
	};

	it("should route ListClients correctly", async () => {
		const res = await dispatchCommand(mockClient, {
			command: "ListClients",
		});
		expect(res.status).toBe("success");
		expect(mockClient.clients.list).toHaveBeenCalled();
		expect(res.messageForAI).toContain("共 1 台机器");
	});

	it("should route RunShellJob with name resolution correctly", async () => {
		const res = await dispatchCommand(mockClient, {
			command: "RunShellJob",
			params: {
				client: "node-1",
				command: "uptime",
			},
		});
		expect(res.status).toBe("success");
		expect(mockClient.jobs.create).toHaveBeenCalledWith({
			clientId: "c1",
			type: "exec",
			payload: {
				command: "uptime",
				timeout: undefined,
			},
		});
	});

	it("should route ReadFile with automatic root detection", async () => {
		const res = await dispatchCommand(mockClient, {
			command: "ReadFile",
			params: {
				client: "node-1",
				path: "/etc/hosts",
			},
		});
		expect(res.status).toBe("success");
		expect(mockClient.files.readText).toHaveBeenCalledWith("c1", "/", "/etc/hosts", undefined);
	});

	it("should throw on unknown command", async () => {
		await expect(
			dispatchCommand(mockClient, {
				command: "NonExistentCommand",
			}),
		).rejects.toThrow('Unknown command identifier: "NonExistentCommand"');
	});
});
