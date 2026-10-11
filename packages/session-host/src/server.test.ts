import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHostPaths } from "./paths.js";
import { startSessionHost } from "./server.js";

const WORKER = [
	"process.stdout.write('ready\\r\\n');",
	"process.stdin.setEncoding('utf8');",
	"process.stdin.on('data', (chunk) => process.stdout.write('echo:' + chunk.replace(/\\r|\\n/g, '') + '\\r\\n'));",
	"process.stdin.resume();",
].join("");

const COMMANDS = { pi: { file: process.execPath, args: ["-e", WORKER] } };

const cleanups: Array<() => Promise<void>> = [];
async function tempPaths(): Promise<SessionHostPaths> {
	const root = await mkdtemp(path.join(os.tmpdir(), "session-host-run-"));
	return {
		root,
		stateDir: path.join(root, "state"),
		runDir: path.join(root, "run"),
		logDir: path.join(root, "log"),
	};
}

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe("宿主进程装配", () => {
	it("启动后写出仅含三字段的控制文件，并可通过本机接口访问身份", async () => {
		const paths = await tempPaths();
		const runtime = await startSessionHost({ paths, commands: COMMANDS, hostId: "host-fixed", token: "t".repeat(64) });
		cleanups.push(async () => {
			await runtime.shutdown();
			await rm(paths.root, { recursive: true, force: true });
		});

		const controlFile = path.join(paths.runDir, "control.json");
		const payload = JSON.parse(await readFile(controlFile, "utf8")) as Record<string, unknown>;
		expect(Object.keys(payload).sort()).toEqual(["hostId", "port", "token"]);
		expect(payload.hostId).toBe("host-fixed");
		expect(payload.port).toBe(runtime.port);

		const res = await fetch(`http://127.0.0.1:${runtime.port}/identity`, {
			headers: { authorization: `Bearer ${runtime.token}` },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { hostId: string }).hostId).toBe("host-fixed");

		const unauthorized = await fetch(`http://127.0.0.1:${runtime.port}/identity`);
		expect(unauthorized.status).toBe(401);
	});

	it(
		"经本机接口跑真实 PTY：启动、快照、停止，且停机后不留运行中实例",
		async () => {
			const paths = await tempPaths();
			const runtime = await startSessionHost({ paths, commands: COMMANDS, hostId: "host-run", token: "u".repeat(64) });
			cleanups.push(async () => {
				await runtime.shutdown();
				await rm(paths.root, { recursive: true, force: true });
			});

			const call = async (route: string, body?: unknown) => {
				const res = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
					method: body === undefined ? "GET" : "POST",
					headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				});
				return { status: res.status, json: (await res.json()) as Record<string, unknown> };
			};

			const started = await call("/start", { operationId: "op_1", kind: "pi", cwd: paths.root });
			expect(started.status).toBe(200);
			const instanceId = started.json.instanceId as string;

			const deadline = Date.now() + 15000;
			let seen = false;
			while (Date.now() < deadline && !seen) {
				const snapshot = await call("/snapshot", { instanceId });
				seen = String(snapshot.json.snapshot ?? "").includes("ready");
				if (!seen) await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(seen).toBe(true);

			const stopped = await call("/stop", { instanceId });
			expect(stopped.status).toBe(200);
			expect(stopped.json.exited).toBe(true);

			await runtime.shutdown();
			expect(runtime.registry.list().every((instance) => instance.state === "stopped")).toBe(true);
			expect(await stat(path.join(paths.runDir, "control.json")).catch(() => null)).toBeNull();
		},
		40000,
	);

	it("配置 DSH 目标后为本机 DSH 开一个独立入口，并在停机时回收", async () => {
		const paths = await tempPaths();
		const fakeDsh = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("dsh-page");
		});
		await new Promise<void>((resolve) => fakeDsh.listen(0, "127.0.0.1", resolve));
		const fakeDshPort = (fakeDsh.address() as AddressInfo).port;

		const runtime = await startSessionHost({
			paths,
			commands: COMMANDS,
			hostId: "host-dsh",
			token: "v".repeat(64),
			dshProxy: { target: { host: "127.0.0.1", port: fakeDshPort } },
		});
		cleanups.push(async () => {
			await runtime.shutdown();
			await new Promise<void>((resolve) => fakeDsh.close(() => resolve()));
			await rm(paths.root, { recursive: true, force: true });
		});

		expect(runtime.dshProxyPort).not.toBeNull();
		expect(runtime.dshProxyPort).not.toBe(runtime.port);
		const viaProxy = await fetch(`http://127.0.0.1:${runtime.dshProxyPort}/`);
		expect(viaProxy.status).toBe(200);
		expect(await viaProxy.text()).toBe("dsh-page");

		await runtime.shutdown();
		await expect(fetch(`http://127.0.0.1:${runtime.dshProxyPort}/`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
	});
});
