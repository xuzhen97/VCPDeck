import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlServer, runPreStart } from "./control.js";

function makeHandlers() {
	return {
		prepare: vi.fn(),
		apply: vi.fn(),
	};
}

/** 测试辅助：读 control.json（带错误包装，满足静态检查） */
async function readControlFile(path: string): Promise<{
	port: number;
	token: string;
	pid: number;
}> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as {
			port: number;
			token: string;
			pid: number;
		};
	} catch (e) {
		throw new Error(
			`读 control.json 失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** 测试辅助：向控制通道发 POST（带错误包装，满足静态检查） */
async function post(
	port: number,
	path: string,
	token: string,
	body?: unknown,
): Promise<Response> {
	try {
		return await fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-launcher-token": token,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (e) {
		throw new Error(
			`控制通道请求失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

describe("createControlServer", () => {
	let dir: string;
	let controlFile: string;
	let server: Awaited<ReturnType<typeof createControlServer>>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "control-"));
		controlFile = join(dir, "control.json");
	});

	afterEach(async () => {
		await server?.close().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	});

	it("启动后写 control.json（port/token/pid），并响应 /prepare", async () => {
		const handlers = makeHandlers();
		handlers.prepare.mockResolvedValue(undefined);
		server = await createControlServer({ handlers, controlFile });

		const control = await readControlFile(controlFile);
		expect(control).toMatchObject({
			port: expect.any(Number),
			token: expect.any(String),
			pid: expect.any(Number),
		});

		const res = await post(control.port, "/prepare", control.token, {
			version: "1.2.1",
			url: "/api/releases/1.2.1/file",
			sha256: "a".repeat(64),
		});
		expect(res.status).toBe(200);
		expect(handlers.prepare).toHaveBeenCalledWith({
			version: "1.2.1",
			url: "/api/releases/1.2.1/file",
			sha256: "a".repeat(64),
		});
	});

	it("token 错误返回 401，不调用 handler", async () => {
		const handlers = makeHandlers();
		server = await createControlServer({ handlers, controlFile });
		const control = await readControlFile(controlFile);

		const res = await post(control.port, "/prepare", "wrong-token", {});

		expect(res.status).toBe(401);
		expect(handlers.prepare).not.toHaveBeenCalled();
	});

	it("handler 抛错返回 500（安全 message）", async () => {
		const handlers = makeHandlers();
		handlers.prepare.mockRejectedValue(new Error("下载失败"));
		server = await createControlServer({ handlers, controlFile });
		const control = await readControlFile(controlFile);

		const res = await post(control.port, "/prepare", control.token, {
			version: "1.2.1",
			url: "/x",
			sha256: "a".repeat(64),
		});

		expect(res.status).toBe(500);
		expect(await res.text()).toContain("下载失败");
	});

	it("/apply 调用 handler；未知路径 404", async () => {
		const handlers = makeHandlers();
		handlers.apply.mockResolvedValue(undefined);
		server = await createControlServer({ handlers, controlFile });
		const control = await readControlFile(controlFile);

		const applyRes = await post(control.port, "/apply", control.token);
		expect(applyRes.status).toBe(200);
		expect(handlers.apply).toHaveBeenCalledTimes(1);

		const missRes = await post(control.port, "/nope", control.token);
		expect(missRes.status).toBe(404);
	});
});

describe("runPreStart", () => {
	it("无命令 → 直接跳过", async () => {
		const execImpl = vi.fn();
		await runPreStart(undefined, "/apps/1.2.1/server", execImpl);
		expect(execImpl).not.toHaveBeenCalled();
	});

	it("有命令 → 在构件目录以 shell 执行", async () => {
		const execImpl = vi.fn().mockResolvedValue({ stdout: "" });
		await runPreStart("prisma db push", "/apps/1.2.1/server", execImpl);
		expect(execImpl).toHaveBeenCalledWith("prisma db push", {
			cwd: "/apps/1.2.1/server",
			shell: true,
			timeout: 120_000,
		});
	});

	it("执行失败 → 抛错（含命令摘要）", async () => {
		const execImpl = vi.fn().mockRejectedValue(new Error("boom"));
		await expect(
			runPreStart("prisma db push", "/apps/1.2.1/server", execImpl),
		).rejects.toThrow("preStart 失败");
	});
});
