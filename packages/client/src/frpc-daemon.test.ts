import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: FakeChild[] = [];
const spawnMock = vi.fn(() => {
	const child = new FakeChild();
	spawned.push(child);
	return child;
});

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
	stderr = new EventEmitter();
	kill = vi.fn(() => true);
}

function socket() {
	return { emit: vi.fn() };
}

const frpsInfo = {
	serverAddr: "frps.example.com",
	serverPort: 7000,
	authToken: "token",
};

let root = "";

beforeEach(async () => {
	vi.resetModules();
	spawnMock.mockClear();
	spawned.length = 0;
	root = mkdtempSync(join(tmpdir(), "vcpdeck-frpc-"));
	const executable = join(root, "frpc.exe");
	writeFileSync(executable, "test");
	process.env.VCPDECK_FRPC_PATH = executable;
	process.env.VCPDECK_FRPC_WORK_DIR = root;
	// 固定 CLIENT_ID，避免 register 模块在测试中读写 ~/.vcpdeck/client-id。
	process.env.VCPDECK_CLIENT_ID = "test-client";
});

afterEach(() => {
	delete process.env.VCPDECK_FRPC_PATH;
	delete process.env.VCPDECK_FRPC_WORK_DIR;
	delete process.env.VCPDECK_CLIENT_ID;
	rmSync(root, { recursive: true, force: true });
});

describe("frpc daemon 原子更新", () => {
	it("create spawn 失败时撤销 registry 并回报安全错误", async () => {
		const { handleFrpCreate, handleFrpList } = await import("./frpc-daemon.js");
		const target = socket();
		const promise = handleFrpCreate(
			{
				_jobId: "create-1",
				mappingId: "fm_1",
				name: "tcp-1919",
				proxyType: "tcp",
				localIp: "127.0.0.1",
				localPort: 1919,
				remotePort: 20000,
				frpsInfo,
			},
			target,
		);
		spawned[0]?.emit("error", new Error("C:/secret/path/frpc failed"));
		await promise;

		expect(target.emit).toHaveBeenCalledWith(
			"job:done",
			expect.objectContaining({
				error: {
					code: "FRPC_START_FAILED",
					message: "frpc 启动失败",
				},
			}),
		);
		const list = socket();
		handleFrpList({ _jobId: "list-1" }, list);
		expect(list.emit).toHaveBeenCalledWith(
			"job:done",
			expect.objectContaining({ result: { mappings: [] } }),
		);
	});

	it("新增第二个 proxy 启动失败时恢复旧 frpc", async () => {
		const { handleFrpCreate, handleFrpList } = await import("./frpc-daemon.js");
		const first = handleFrpCreate(
			{
				_jobId: "create-1",
				mappingId: "fm_1",
				name: "tcp-1919",
				proxyType: "tcp",
				localIp: "127.0.0.1",
				localPort: 1919,
				remotePort: 20000,
				frpsInfo,
			},
			socket(),
		);
		spawned.at(-1)?.emit("spawn");
		await first;

		const target = socket();
		const second = handleFrpCreate(
			{
				_jobId: "create-2",
				mappingId: "fm_2",
				name: "tcp-2020",
				proxyType: "tcp",
				localIp: "127.0.0.1",
				localPort: 2020,
				remotePort: 20001,
				frpsInfo,
			},
			target,
		);
		spawned.at(-1)?.emit("error", new Error("restart failed"));
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3));
		spawned.at(-1)?.emit("spawn");
		await second;

		const list = socket();
		handleFrpList({ _jobId: "list" }, list);
		expect(list.emit).toHaveBeenCalledWith(
			"job:done",
			expect.objectContaining({
				result: {
					mappings: [expect.objectContaining({ id: "fm_1", status: "active" })],
				},
			}),
		);
	});

	it("delete 重启失败时恢复被删除的 registry 并回报错误", async () => {
		const { handleFrpCreate, handleFrpDelete, handleFrpList } = await import(
			"./frpc-daemon.js"
		);
		for (const [mappingId, name, port] of [
			["fm_1", "tcp-1919", 1919],
			["fm_2", "tcp-2020", 2020],
		] as const) {
			const promise = handleFrpCreate(
				{
					_jobId: `create-${mappingId}`,
					mappingId,
					name,
					proxyType: "tcp",
					localIp: "127.0.0.1",
					localPort: port,
					remotePort: 20000 + port,
					frpsInfo,
				},
				socket(),
			);
			spawned.at(-1)?.emit("spawn");
			await promise;
		}

		const target = socket();
		const deletion = handleFrpDelete(
			{ _jobId: "delete-1", mappingId: "fm_1", name: "tcp-1919" },
			target,
		);
		spawned.at(-1)?.emit("error", new Error("restart failed"));
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(4));
		spawned.at(-1)?.emit("spawn");
		await deletion;
		expect(target.emit).toHaveBeenCalledWith(
			"job:done",
			expect.objectContaining({
				error: { code: "FRPC_START_FAILED", message: "frpc 启动失败" },
			}),
		);
		// 失败后恢复旧 registry 并再次启动原配置。
		const list = socket();
		handleFrpList({ _jobId: "list-1" }, list);
		expect(list.emit).toHaveBeenCalledWith(
			"job:done",
			expect.objectContaining({
				result: {
					mappings: expect.arrayContaining([
						expect.objectContaining({ id: "fm_1" }),
						expect.objectContaining({ id: "fm_2" }),
					]),
				},
			}),
		);
	});

	it("reconcile 成功回报安全 result，不含 authToken", async () => {
		const { handleFrpReconcile } = await import("./frpc-daemon.js");
		const target = socket();
		const promise = handleFrpReconcile(
			{
				_jobId: "reconcile-1",
				connectionGeneration: "conn-1",
				expectedRuntimeGeneration: 1,
				attempt: 0,
				timeoutSeconds: 30,
				frpsInfo,
				mappings: [
					{
						mappingId: "fm_1",
						name: "tcp-1919",
						proxyType: "tcp",
						localIp: "127.0.0.1",
						localPort: 1919,
						remotePort: 20000,
						customDomain: null,
					},
				],
				preservedMappings: [],
			},
			target,
		);
		spawned.at(-1)?.emit("spawn");
		await promise;

		const done = target.emit.mock.calls.find(
			(call) => call[0] === "job:done",
		)?.[1] as { result?: Record<string, unknown> };
		expect(done.result).toMatchObject({
			status: "running",
			loadedMappingIds: ["fm_1"],
		});
		expect(JSON.stringify(done.result)).not.toContain("token");
		expect(JSON.stringify(done.result)).not.toContain("authToken");
	});

	it("reconcile payload 含未知字段时回报 FRP_RUNTIME_STATE_INVALID", async () => {
		const { handleFrpReconcile } = await import("./frpc-daemon.js");
		const target = socket();
		await handleFrpReconcile(
			{
				_jobId: "reconcile-2",
				connectionGeneration: "conn-1",
				expectedRuntimeGeneration: 1,
				attempt: 0,
				timeoutSeconds: 30,
				frpsInfo,
				mappings: [],
				preservedMappings: [],
				extraField: "nope",
			},
			target,
		);
		expect(target.emit).toHaveBeenCalledWith(
			"job:done",
			expect.objectContaining({
				error: expect.objectContaining({ code: "FRP_RUNTIME_STATE_INVALID" }),
			}),
		);
	});

	it("旧 connection generation 的 reconcile 被 FRP_RUNTIME_GENERATION_STALE 拒绝", async () => {
		const { handleFrpReconcile, setFrpConnectionGeneration } = await import(
			"./frpc-daemon.js"
		);
		setFrpConnectionGeneration("conn-1");
		const mapping = {
			mappingId: "fm_1",
			name: "tcp-1919",
			proxyType: "tcp" as const,
			localIp: "127.0.0.1",
			localPort: 1919,
			remotePort: 20000,
			customDomain: null,
		};
		const base = {
			expectedRuntimeGeneration: 1,
			attempt: 0,
			timeoutSeconds: 30,
			frpsInfo,
			mappings: [mapping],
			preservedMappings: [],
		};
		const first = socket();
		const firstDone = handleFrpReconcile({ _jobId: "r-1", connectionGeneration: "conn-1", ...base }, first);
		spawned.at(-1)?.emit("spawn");
		await firstDone;

		const stale = socket();
		const staleDone = handleFrpReconcile({ _jobId: "r-2", connectionGeneration: "conn-old", ...base }, stale);
		await staleDone;
		expect(stale.emit).toHaveBeenCalledWith(
			"job:done",
			expect.objectContaining({
				error: expect.objectContaining({ code: "FRP_RUNTIME_GENERATION_STALE" }),
			}),
		);
		expect(first.emit).toHaveBeenCalledWith(
			"job:done",
			expect.objectContaining({ result: expect.objectContaining({ status: "running" }) }),
		);
	});
});
