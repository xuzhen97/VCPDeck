import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events, type StatusReport } from "@vcpdeck/shared";
import { attachClientBridge, isMigrationVerifyOnly } from "./index.js";

function fakeSocket() {
	const handlers: Record<string, Array<(...a: unknown[]) => unknown>> = {};
	const emits: Array<{ event: string; args: unknown[] }> = [];
	const socket = {
		on: (event: string, cb: (...a: unknown[]) => unknown) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(cb);
			return socket;
		},
		emit: (event: string, ...args: unknown[]) => {
			emits.push({ event, args });
			return socket;
		},
		connected: true,
		data: {},
		disconnect: () => {},
		connect: () => {},
	} as unknown as Socket;
	return { socket, handlers, emits };
}

function makeDeps() {
	return {
		deps: {
			clientId: "c1",
			getTerminalStatus: async () => undefined,
			getRuntimeSecurity: async () => undefined,
			getRegister: () =>
				({
					clientId: "c1",
					hostname: "host",
					os: "linux 1",
					cpuModel: "cpu",
					totalMemMB: 1,
					clientVersion: "1",
					capabilities: [],
				}) as never,
			getStatusReport: () => ({ clientId: "c1", jobs: [] } as StatusReport),
		},
	};
}

describe("attachClientBridge 迁移验证模式（verifyOnly）", () => {
	it("verifyOnly=true：注册后不下发 STATUS_REPORT", async () => {
		const { socket, handlers, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never, {
			verifyOnly: true,
		});

		await bridge.onConnected();
		handlers["ack"]?.[0]?.({ event: Events.REGISTER });

		expect(emits.filter((e) => e.event === Events.REGISTER)).toHaveLength(1);
		expect(emits.some((e) => e.event === Events.STATUS_REPORT)).toBe(false);
	});

	it("verifyOnly 缺省（稳态）：注册 ack 后下发 STATUS_REPORT", async () => {
		const { socket, handlers, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never);

		await bridge.onConnected();
		handlers["ack"]?.[0]?.({ event: Events.REGISTER });

		expect(emits.some((e) => e.event === Events.STATUS_REPORT)).toBe(true);
	});

	it("注册回调直接调用时也只上报一次状态", async () => {
		const { socket, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never);

		await bridge.onConnected();
		const register = emits.find((e) => e.event === Events.REGISTER);
		const ack = register?.args[1] as (() => void) | undefined;
		ack?.();
		ack?.();

		expect(emits.filter((e) => e.event === Events.STATUS_REPORT)).toHaveLength(1);
	});

	it("被取代的连接不重复发 REGISTER", async () => {
		const { socket, emits } = fakeSocket();
		const { deps } = makeDeps();
		const gate: { release?: () => void } = {};
		let calls = 0;
		const slowDeps = {
			...deps,
			getTerminalStatus: async () => {
				calls += 1;
				if (calls === 1) {
					await new Promise<void>((resolve) => {
						gate.release = resolve;
					});
				}
				return undefined;
			},
		};
		const bridge = attachClientBridge(socket, slowDeps as never);

		const first = bridge.onConnected(); // 探测很慢
		const second = bridge.onConnected(); // 新连接代次
		gate.release?.();
		await Promise.all([first, second]);

		expect(emits.filter((e) => e.event === Events.REGISTER)).toHaveLength(1);
	});

	it("不再挂载任何 Pi 专用处理器", () => {
		const { socket, handlers } = fakeSocket();
		const { deps } = makeDeps();
		attachClientBridge(socket, deps as never);

		for (const event of ["pi:request", "pi:event", "pi:runtime-spec"]) {
			expect(handlers[event] ?? []).toHaveLength(0);
		}
	});
});

describe("isMigrationVerifyOnly", () => {
	it("VCPDECK_MIGRATION_VERIFY_ONLY=1 → true；其他 → false", () => {
		expect(isMigrationVerifyOnly({ VCPDECK_MIGRATION_VERIFY_ONLY: "1" })).toBe(true);
		expect(isMigrationVerifyOnly({})).toBe(false);
		expect(isMigrationVerifyOnly({ VCPDECK_MIGRATION_VERIFY_ONLY: "0" })).toBe(false);
	});
});
