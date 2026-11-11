/**
 * Tailnet 只读探测单测（ADR-0062）。
 *
 * 探测只允许读取 backend 状态与本机标识，绝不读取或上传 peer 列表。
 */
import { describe, expect, it } from "vitest";
import {
	probeTailnet,
	projectTailnetStatus,
	type TailnetCommandResult,
	type TailnetCommandRunner,
} from "./probe.js";

const OBSERVED_AT = "2026-11-11T00:00:00.000Z";

function ok(stdout: string): TailnetCommandResult {
	return { ok: true, stdout };
}

function failed(extra: Partial<TailnetCommandResult> = {}): TailnetCommandResult {
	return { ok: false, stdout: "", ...extra };
}

function runner(
	version: TailnetCommandResult,
	status?: TailnetCommandResult,
): { run: TailnetCommandRunner; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: async (args) => {
			calls.push(args);
			if (args[0] === "version") {
				return version;
			}
			return status ?? failed();
		},
	};
}

function statusJson(backendState: string): string {
	return JSON.stringify({
		BackendState: backendState,
		Self: {
			DNSName: "node.example.ts.net.",
			TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1", "not-an-ip"],
		},
		Peer: { private: { HostName: "must-not-upload" } },
	});
}

describe("Tailnet 状态投影", () => {
	it("未知 BackendState 归为 unknown，且不携带 Peer 字段", () => {
		const snapshot = projectTailnetStatus(
			{
				BackendState: "FutureState",
				Self: {
					DNSName: "node.example.ts.net.",
					TailscaleIPs: ["100.64.0.1"],
				},
				Peer: { private: { HostName: "must-not-upload" } },
			},
			OBSERVED_AT,
		);
		expect(snapshot.backend).toBe("unknown");
		expect(snapshot.nodeName).toBe("node.example.ts.net");
		expect(snapshot.ipv4).toEqual(["100.64.0.1"]);
		expect(JSON.stringify(snapshot)).not.toContain("must-not-upload");
	});

	it("Running/NeedsLogin/NeedsMachineAuth/Stopped 映射为受限枚举", () => {
		expect(projectTailnetStatus({ BackendState: "Running" }, OBSERVED_AT).backend).toBe("running");
		expect(projectTailnetStatus({ BackendState: "NeedsLogin" }, OBSERVED_AT).backend).toBe("needs-login");
		expect(projectTailnetStatus({ BackendState: "NeedsMachineAuth" }, OBSERVED_AT).backend).toBe("needs-approval");
		expect(projectTailnetStatus({ BackendState: "Stopped" }, OBSERVED_AT).backend).toBe("stopped");
	});

	it("缺字段与畸形输入一律降级 unknown，不抛错", () => {
		for (const raw of [null, 42, "x", {}, { Self: "bad" }]) {
			const snapshot = projectTailnetStatus(raw, OBSERVED_AT);
			expect(snapshot.backend).toBe("unknown");
			expect(snapshot.observedAt).toBe(OBSERVED_AT);
		}
	});
});

describe("Tailnet 只读探测", () => {
	it("binary 不存在 → installed=no 与 CLI_MISSING，不再执行 status", async () => {
		const version = runner(failed({ missing: true }));
		const snapshot = await probeTailnet({ run: version.run, now: () => OBSERVED_AT });
		expect(snapshot.installed).toBe("no");
		expect(snapshot.errorCode).toBe("TAILNET_CLI_MISSING");
		expect(version.calls).toHaveLength(1);
	});

	it("backend running 时返回本机标识与版本，且命令含 --peers=false", async () => {
		const { run, calls } = runner(ok("1.104.5\n  tailscale commit: abc\n"), ok(statusJson("Running")));
		const snapshot = await probeTailnet({ run, now: () => OBSERVED_AT });
		expect(snapshot).toMatchObject({
			installed: "yes",
			version: "1.104.5",
			service: "running",
			backend: "running",
			nodeName: "node.example.ts.net",
			errorCode: null,
		});
		expect(snapshot.ipv4).toEqual(["100.64.0.1"]);
		expect(snapshot.ipv6).toEqual(["fd7a:115c:a1e0::1"]);
		expect(calls[1]).toEqual(["status", "--json", "--peers=false"]);
	});

	it("NeedsLogin / NeedsMachineAuth / Stopped 分别映射", async () => {
		for (const [state, backend] of [
			["NeedsLogin", "needs-login"],
			["NeedsMachineAuth", "needs-approval"],
			["Stopped", "stopped"],
		] as const) {
			const { run } = runner(ok("1.104.5\n"), ok(statusJson(state)));
			const snapshot = await probeTailnet({ run, now: () => OBSERVED_AT });
			expect(snapshot.backend).toBe(backend);
		}
	});

	it("CLI 在但服务未运行 → installed=yes、service=stopped、backend=unknown", async () => {
		const { run } = runner(ok("1.104.5\n"), failed());
		const snapshot = await probeTailnet({ run, now: () => OBSERVED_AT });
		expect(snapshot).toMatchObject({
			installed: "yes",
			service: "stopped",
			backend: "unknown",
			errorCode: "TAILNET_CLI_FAILED",
		});
	});

	it("stderr/超大输出/畸形 JSON 一律 CLI_FAILED", async () => {
		const big = runner(ok("1.104.5\n"), failed({ outputTooLarge: true }));
		expect((await probeTailnet({ run: big.run })).errorCode).toBe("TAILNET_CLI_FAILED");

		const broken = runner(ok("1.104.5\n"), ok("{not json"));
		const brokenSnapshot = await probeTailnet({ run: broken.run });
		expect(brokenSnapshot.installed).toBe("yes");
		expect(brokenSnapshot.errorCode).toBe("TAILNET_CLI_FAILED");
	});

	it("version 超时 → installed=unknown 与 PROBE_TIMEOUT", async () => {
		const { run } = runner(failed({ timedOut: true }));
		const snapshot = await probeTailnet({ run, now: () => OBSERVED_AT });
		expect(snapshot.installed).toBe("unknown");
		expect(snapshot.errorCode).toBe("TAILNET_PROBE_TIMEOUT");
	});
});
