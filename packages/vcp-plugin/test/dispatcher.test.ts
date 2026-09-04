import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchCommand, VCP_COMMANDS } from "../src/dispatcher.js";
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
			export: vi.fn().mockResolvedValue({ fileId: "file-1", key: "secret-key", size: 3, sha256: "hash" }),
		},
		storageShares: {
			create: vi.fn().mockResolvedValue({ filename: "photo.png", previewable: true, sharePath: "/api/public/storage-shares/token" }),
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

	it("routes DownloadFile to export and create a public share", async () => {
		const res = await dispatchCommand(mockClient, {
			command: "DownloadFile",
			client: "node-1",
			path: "/tmp/photo.png",
		}, "https://deck.example");
		expect(res.status).toBe("success");
		expect(mockClient.files.export).toHaveBeenCalledWith("c1", { rootDir: "/", path: "/tmp/photo.png" });
		expect(mockClient.storageShares.create).toHaveBeenCalledWith({ fileId: "file-1" });
		expect(res.content?.[0]?.text).toContain("https://deck.example/api/public/storage-shares/token");
		expect(res.content?.[1]).toEqual({ type: "image_url", image_url: { url: "https://deck.example/api/public/storage-shares/token" } });
	});

	it("should reject DownloadFile without an HTTP(S) public share base", async () => {
		await expect(dispatchCommand(mockClient, { command: "DownloadFile", client: "node-1", path: "a.txt" }, "ftp://deck.example"))
			.rejects.toThrow("PUBLIC_SHARE_BASE_URL");
	});

	it("should throw on unknown command", async () => {
		await expect(
			dispatchCommand(mockClient, {
				command: "NonExistentCommand",
			}),
		).rejects.toThrow('Unknown command identifier: "NonExistentCommand"');
	});

	it("routes flat VCPToolBox arguments and keeps command as the action", async () => {
		await dispatchCommand(mockClient, {
			command: "RunShellJob",
			client: "node-1",
			shellCommand: "node -e \"console.log('marker')\"",
		});

		expect(mockClient.jobs.create).toHaveBeenCalledWith({
			clientId: "c1",
			type: "exec",
			payload: {
				command: "node -e \"console.log('marker')\"",
				timeout: undefined,
			},
		});
	});

	it("lets explicit params override flat fields", async () => {
		await dispatchCommand(mockClient, {
			command: "ReadFile",
			client: "wrong-flat-client",
			path: "/wrong",
			params: { client: "node-1", path: "/etc/hosts" },
		});

		expect(mockClient.files.readText).toHaveBeenCalledWith(
			"c1",
			"/",
			"/etc/hosts",
			undefined,
		);
	});
});

describe("VCPDeckBridge Dispatcher Matrix", () => {
	let mockClient: any;

	beforeEach(() => {
		mockClient = {
			clients: {
				list: vi.fn().mockResolvedValue([{ clientId: "c1", name: "node-1" }]),
			},
			jobs: {
				create: vi.fn().mockResolvedValue({ jobId: "job-1", status: "pending" }),
				list: vi.fn().mockResolvedValue({ total: 1, page: 1, totalPages: 1, data: [] }),
				get: vi.fn().mockResolvedValue({ jobId: "job-1", status: "done" }),
				output: vi.fn().mockResolvedValue({ jobId: "job-1", output: "stdout" }),
				cancel: vi.fn().mockResolvedValue({ jobId: "job-1", status: "cancelled" }),
			},
			files: {
				roots: vi.fn().mockResolvedValue(["/"]),
				export: vi.fn().mockResolvedValue({ fileId: "file-1", key: "key", size: 1, sha256: "hash" }),
				list: vi.fn().mockResolvedValue({ files: [] }),
				stat: vi.fn().mockResolvedValue({ path: "/tmp/a", size: 100 }),
				readText: vi.fn().mockResolvedValue("file content"),
				writeText: vi.fn().mockResolvedValue({ path: "/tmp/a", bytesWritten: 10 }),
				mkdir: vi.fn().mockResolvedValue({ path: "/tmp/d" }),
				delete: vi.fn().mockResolvedValue({ path: "/tmp/a" }),
				move: vi.fn().mockResolvedValue({ source: "/tmp/a", target: "/tmp/b" }),
			},
			frp: {
				instances: {
					list: vi.fn().mockResolvedValue({ total: 1, page: 1, totalPages: 1, data: [] }),
				},
				list: vi.fn().mockResolvedValue({ total: 1, page: 1, totalPages: 1, data: [] }),
				get: vi.fn().mockResolvedValue({ mappingId: "mapping-1", status: "active" }),
				create: vi.fn().mockResolvedValue({ mappingId: "mapping-1", status: "provisioning" }),
				delete: vi.fn().mockResolvedValue({ mappingId: "mapping-1", status: "deleting" }),
			},
			storage: {
				getBackendConfig: vi.fn().mockResolvedValue({ type: "local" }),
			},
			storageShares: {
				create: vi.fn().mockResolvedValue({ filename: "file.txt", previewable: false, sharePath: "/api/public/storage-shares/token" }),
			},
			releases: {
				list: vi.fn().mockResolvedValue({ total: 1, page: 1, totalPages: 1, data: [] }),
			},
		};
	});

	const cases: { command: string; args: Record<string, unknown>; spy: () => ReturnType<typeof vi.fn> }[] = [
		{ command: "ListClients", args: {}, spy: () => mockClient.clients.list },
		{ command: "ListJobs", args: { client: "node-1", status: "error", page: "1", pageSize: "10" }, spy: () => mockClient.jobs.list },
		{ command: "GetJob", args: { jobId: "job-1" }, spy: () => mockClient.jobs.get },
		{ command: "GetJobOutput", args: { jobId: "job-1" }, spy: () => mockClient.jobs.output },
		{ command: "RunShellJob", args: { client: "node-1", shellCommand: "node --version", timeout: "10" }, spy: () => mockClient.jobs.create },
		{ command: "CancelJob", args: { jobId: "job-1" }, spy: () => mockClient.jobs.cancel },
		{ command: "ListRoots", args: { client: "node-1" }, spy: () => mockClient.files.roots },
		{ command: "ListDirectory", args: { client: "node-1", path: "/tmp" }, spy: () => mockClient.files.list },
		{ command: "StatFile", args: { client: "node-1", path: "/tmp/a" }, spy: () => mockClient.files.stat },
		{ command: "ReadFile", args: { client: "node-1", path: "/tmp/a", limit: "64" }, spy: () => mockClient.files.readText },
		{ command: "WriteFile", args: { client: "node-1", path: "/tmp/a", content: "x" }, spy: () => mockClient.files.writeText },
		{ command: "MakeDirectory", args: { client: "node-1", path: "/tmp/d" }, spy: () => mockClient.files.mkdir },
		{ command: "DeleteFile", args: { client: "node-1", path: "/tmp/a" }, spy: () => mockClient.files.delete },
		{ command: "MoveFile", args: { client: "node-1", source: "/tmp/a", target: "/tmp/b" }, spy: () => mockClient.files.move },
		{ command: "ListFrpInstances", args: { page: "1", pageSize: "10" }, spy: () => mockClient.frp.instances.list },
		{ command: "ListFrpMappings", args: { client: "node-1" }, spy: () => mockClient.frp.list },
		{ command: "GetFrpMapping", args: { mappingId: "mapping-1" }, spy: () => mockClient.frp.get },
		{ command: "CreateFrpMapping", args: { client: "node-1", localPort: "8080", remotePort: "18080", type: "tcp" }, spy: () => mockClient.frp.create },
		{ command: "DeleteFrpMapping", args: { mappingId: "mapping-1" }, spy: () => mockClient.frp.delete },
		{ command: "GetStorageStatus", args: {}, spy: () => mockClient.storage.getBackendConfig },
		{ command: "ListReleases", args: { page: "1", pageSize: "10" }, spy: () => mockClient.releases.list },
		{ command: "DownloadFile", args: { client: "node-1", path: "/tmp/file.txt" }, spy: () => mockClient.files.export },
	];

	it("VCP_COMMANDS matches matrix command set", () => {
		expect([...VCP_COMMANDS].sort()).toEqual(cases.map((c) => c.command).sort());
	});

	for (const { command, args, spy } of cases) {
		it(`routes ${command}`, async () => {
			const res = await dispatchCommand(mockClient as any, { command, ...args }, "https://deck.example");
			expect(res.status).toBe("success");
			expect(spy()).toHaveBeenCalled();
		});
	}
});
