import type { JobDispatch, TailnetSnapshot } from "@vcpdeck/shared";
import { Events } from "@vcpdeck/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildTailnetJoinArgs,
	cancelTailnetJob,
	configureTailnetJobDeps,
	getActiveTailnetJobIds,
	handleTailnetJob,
	isTailnetBusy,
	resetTailnetJobDeps,
	type TailnetJobDeps,
} from "./handler.js";

interface Emitted {
	event: string;
	payload: any;
}

function fakeSocket(): { socket: { emit: (event: string, payload: unknown) => void }; emits: Emitted[] } {
	const emits: Emitted[] = [];
	return {
		socket: {
			emit(event, payload) {
				emits.push({ event, payload });
			},
		},
		emits,
	};
}

function snapshot(overrides: Partial<TailnetSnapshot> = {}): TailnetSnapshot {
	return {
		installed: "yes",
		version: "1.104.5",
		service: "running",
		backend: "needs-login",
		nodeName: null,
		ipv4: [],
		ipv6: [],
		observedAt: "2026-11-11T00:00:00.000Z",
		errorCode: null,
		...overrides,
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function tailnetJob(
	payload: Record<string, unknown>,
	jobId = "job-1",
): JobDispatch {
	return { jobId, type: "tailnet.manage", payload } as JobDispatch;
}

function baseDeps(overrides: Partial<TailnetJobDeps> = {}): {
	deps: TailnetJobDeps;
	calls: {
		probe: number;
		install: number;
		start: number;
		join: number;
		allow: number;
		forget: number;
		request: number;
		secretFile: number;
	};
} {
	const calls = {
		probe: 0,
		install: 0,
		start: 0,
		join: 0,
		allow: 0,
		forget: 0,
		request: 0,
		secretFile: 0,
	};
	const deps: TailnetJobDeps = {
		platform: "linux",
		probe: async () => {
			calls.probe += 1;
			return snapshot();
		},
		install: async () => {
			calls.install += 1;
		},
		startService: async () => {
			calls.start += 1;
		},
		runJoin: async () => {
			calls.join += 1;
			return { ok: true };
		},
		requestSecret: async () => {
			calls.request += 1;
			return "tskey-test";
		},
		allowSecret: () => {
			calls.allow += 1;
		},
		forgetSecret: () => {
			calls.forget += 1;
		},
		withSecretFile: <T>(_authKey: string, run: (path: string) => Promise<T>) => {
			calls.secretFile += 1;
			return run("/private/authkey");
		},
		...overrides,
	};
	return { deps, calls };
}

function donePayload(emits: Emitted[]): any {
	const done = emits.filter((entry) => entry.event === Events.JOB_DONE);
	expect(done).toHaveLength(1);
	return done[0]?.payload;
}

beforeEach(() => {
	resetTailnetJobDeps();
});

afterEach(() => {
	resetTailnetJobDeps();
});

describe("buildTailnetJoinArgs", () => {
	it("固定参数防止改 DNS/路由/SSH/Exit Node，并为 Windows 追加无人值守标志", () => {
		expect(buildTailnetJoinArgs("/private/authkey", false)).toEqual([
			"up",
			"--auth-key=file:/private/authkey",
			"--accept-dns=false",
			"--accept-routes=false",
			"--ssh=false",
			"--advertise-exit-node=false",
			"--advertise-routes=",
			"--exit-node=",
			"--timeout=60s",
		]);
		expect(buildTailnetJoinArgs("C:\\Temp\\authkey", true)).toEqual([
			"up",
			"--auth-key=file:C:\\Temp\\authkey",
			"--accept-dns=false",
			"--accept-routes=false",
			"--ssh=false",
			"--advertise-exit-node=false",
			"--advertise-routes=",
			"--exit-node=",
			"--timeout=60s",
			"--unattended=true",
		]);
	});
});

describe("handleTailnetJob inspect", () => {
	it("只探测一次并返回 inspected，不请求密钥、不安装", async () => {
		const { deps, calls } = baseDeps();
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		await handleTailnetJob(tailnetJob({ action: "inspect" }), socket);

		const payload = donePayload(emits);
		expect(payload.jobId).toBe("job-1");
		expect(payload.type).toBe("tailnet.manage");
		expect(payload.result.stage).toBe("inspected");
		expect(payload.result.snapshot.installed).toBe("yes");
		expect(calls.probe).toBe(1);
		expect(calls.request).toBe(0);
		expect(calls.install).toBe(0);
	});
});

describe("handleTailnetJob ensure", () => {
	it("已有登录时直接返回 existing-login，不请求密钥也不执行 up", async () => {
		const { deps, calls } = baseDeps({
			probe: async () => snapshot({ backend: "running", nodeName: "node.example.ts.net" }),
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		await handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false }),
			socket,
		);

		const payload = donePayload(emits);
		expect(payload.result.stage).toBe("existing-login");
		expect(calls.request).toBe(0);
		expect(calls.join).toBe(0);
	});

	it("未安装且未允许安装时安全失败，不产生任何副作用", async () => {
		const { deps, calls } = baseDeps({
			probe: async () => snapshot({ installed: "no", version: null, service: "unknown", backend: "unknown", errorCode: "TAILNET_CLI_MISSING" }),
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		await handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false }),
			socket,
		);

		const payload = donePayload(emits);
		expect(payload.error.code).toBe("TAILNET_CLI_MISSING");
		expect(calls.install).toBe(0);
		expect(calls.request).toBe(0);
		expect(calls.join).toBe(0);
	});

	it("安装成功后登录失败仍保留安装结果，不尝试卸载", async () => {
		const snapshots = [
			snapshot({ installed: "no", version: null, service: "unknown", backend: "unknown" }),
			snapshot({ backend: "needs-login" }),
			snapshot({ backend: "needs-login" }),
		];
		const { deps, calls } = baseDeps({
			probe: async () => {
				calls.probe += 1;
				return snapshots.shift() ?? snapshot({ backend: "needs-login" });
			},
			runJoin: async () => {
				calls.join += 1;
				return { ok: false };
			},
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		await handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: true }),
			socket,
		);

		const payload = donePayload(emits);
		expect(payload.error.code).toBe("TAILNET_JOIN_FAILED");
		expect(calls.install).toBe(1);
		expect(calls.join).toBe(1);
	});

	it("未登录且无既有身份时请求一次密钥、经受限文件执行 up，并返回 joined", async () => {
		const joinedPath: string[] = [];
		const snapshots = [
			snapshot({ backend: "needs-login" }),
			snapshot({ backend: "running", nodeName: "node.example.ts.net", ipv4: ["100.64.0.1"] }),
		];
		const { deps, calls } = baseDeps({
			probe: async () => {
				calls.probe += 1;
				return snapshots.shift() ?? snapshot({ backend: "running" });
			},
			runJoin: async (secretPath) => {
				calls.join += 1;
				joinedPath.push(secretPath);
				return { ok: true };
			},
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		await handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false }),
			socket,
		);

		const payload = donePayload(emits);
		expect(payload.result.stage).toBe("joined");
		expect(payload.result.snapshot.backend).toBe("running");
		expect(joinedPath).toEqual(["/private/authkey"]);
		expect(calls.request).toBe(1);
		expect(calls.allow).toBe(1);
		expect(calls.forget).toBe(1);
		expect(calls.secretFile).toBe(1);
	});

	it("NeedsMachineAuth 返回 awaiting-approval，不请求密钥", async () => {
		const { deps, calls } = baseDeps({
			probe: async () => snapshot({ backend: "needs-approval" }),
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		await handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false }),
			socket,
		);

		const payload = donePayload(emits);
		expect(payload.result.stage).toBe("awaiting-approval");
		expect(calls.request).toBe(0);
	});

	it("服务已停止且无法确认未登录时拒绝覆盖（EXISTING_CONFIG）", async () => {
		const { deps, calls } = baseDeps({
			probe: async () => snapshot({ service: "stopped", backend: "stopped" }),
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		await handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false }),
			socket,
		);

		const payload = donePayload(emits);
		expect(payload.error.code).toBe("TAILNET_EXISTING_CONFIG");
		expect(calls.request).toBe(0);
	});

	it("密钥请求失败时回传稳定错误码，不执行 up", async () => {
		const { deps, calls } = baseDeps({
			requestSecret: async () => {
				calls.request += 1;
				throw Object.assign(new Error("等待密钥响应超时"), {
					code: "TAILNET_SECRET_TIMEOUT",
				});
			},
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		await handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false }),
			socket,
		);

		const payload = donePayload(emits);
		expect(payload.error.code).toBe("TAILNET_SECRET_TIMEOUT");
		expect(calls.join).toBe(0);
		expect(calls.forget).toBe(1);
	});
});

describe("handleTailnetJob 并发与取消", () => {
	it("重复派发同一 jobId 不重复执行", async () => {
		const gate = deferred<string>();
		const { deps, calls } = baseDeps({
			probe: async () => {
				calls.probe += 1;
				return calls.probe >= 2
					? snapshot({ backend: "running" })
					: snapshot({ backend: "needs-login" });
			},
			requestSecret: async () => {
				calls.request += 1;
				return gate.promise;
			},
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();
		const job = tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false });

		const first = handleTailnetJob(job, socket);
		await vi.waitFor(() => expect(calls.request).toBe(1));
		expect(getActiveTailnetJobIds()).toEqual(["job-1"]);
		expect(isTailnetBusy()).toBe(true);
		await handleTailnetJob(job, socket);
		expect(emits).toHaveLength(0);

		gate.resolve("tskey-test");
		await first;
		expect(donePayload(emits).result.stage).toBe("joined");
		expect(isTailnetBusy()).toBe(false);
	});

	it("已有管理任务在途时拒绝第二个 job（OPERATION_BUSY）", async () => {
		const gate = deferred<string>();
		const { deps, calls } = baseDeps({
			probe: async () => {
				calls.probe += 1;
				return calls.probe >= 2
					? snapshot({ backend: "running" })
					: snapshot({ backend: "needs-login" });
			},
			requestSecret: async () => {
				calls.request += 1;
				return gate.promise;
			},
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		const first = handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false }),
			socket,
		);
		await vi.waitFor(() => expect(calls.request).toBe(1));

		await handleTailnetJob(
			tailnetJob({ action: "inspect" }, "job-2"),
			socket,
		);
		expect(emits).toHaveLength(1);
		expect(emits[0]?.payload.error.code).toBe("TAILNET_OPERATION_BUSY");

		gate.resolve("tskey-test");
		await first;
		expect(emits).toHaveLength(2);
		expect(emits[1]?.payload.result.stage).toBe("joined");
	});

	it("取消在途任务会中止等待、清理允许集合并返回 interrupted", async () => {
		const { deps, calls } = baseDeps({
			requestSecret: (_jobId, signal) =>
				new Promise<string>((_resolve, reject) => {
					calls.request += 1;
					signal.addEventListener(
						"abort",
						() => {
							reject(
								Object.assign(new Error("请求已取消"), {
									code: "TAILNET_SECRET_DENIED",
								}),
							);
						},
						{ once: true },
					);
				}),
		});
		configureTailnetJobDeps(deps);
		const { socket, emits } = fakeSocket();

		const running = handleTailnetJob(
			tailnetJob({ action: "ensure", credentialId: "key-1", installIfMissing: false }),
			socket,
		);
		await vi.waitFor(() => expect(calls.request).toBe(1));

		expect(cancelTailnetJob("job-1")).toBe(true);
		expect(cancelTailnetJob("missing")).toBe(false);
		await running;

		const payload = donePayload(emits);
		expect(payload.result.stage).toBe("interrupted");
		expect(calls.forget).toBe(1);
		expect(calls.join).toBe(0);
		expect(getActiveTailnetJobIds()).toEqual([]);
		expect(isTailnetBusy()).toBe(false);
	});
});
