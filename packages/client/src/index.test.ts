import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events, type PiEvent, type PiStateAck, type StatusReport } from "@vcpdeck/shared";
import { attachPiBridge, isMigrationVerifyOnly } from "./index.js";

function fakeSocket() {
	const handlers: Record<string, Array<(...a: unknown[]) => unknown>> = {};
	const socket = {
		on: (event: string, cb: (...a: unknown[]) => unknown) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(cb);
			return socket;
		},
		emit: () => socket,
		connected: true,
		data: {},
		disconnect: () => {},
		connect: () => {},
	} as unknown as Socket;
	return { socket, handlers };
}

function makeDeps() {
	const supervisor = {
		request: vi.fn(async () => ({ requestId: "r1", ok: true, data: {} })),
		onEvent: vi.fn(),
		getStateReport: vi.fn(() => ({ clientId: "c1", runs: [] })),
		applyStateAck: vi.fn(async () => ({ allClosed: false })),
	};
	return {
		supervisor,
		deps: {
			clientId: "c1",
			supervisor,
			getPiStatus: async () => undefined,
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

describe("attachPiBridge 迁移验证模式（verifyOnly）", () => {
	it("verifyOnly=true：不挂载 PI_REQUEST / PI_EVENT 工作处理器", () => {
		const { socket, handlers } = fakeSocket();
		const { deps, supervisor } = makeDeps();
		attachPiBridge(socket, deps as never, { verifyOnly: true });

		expect(handlers[Events.PI_REQUEST] ?? []).toHaveLength(0);
		expect(handlers[Events.PI_EVENT] ?? []).toHaveLength(0);
		// supervisor 事件转发也不应被绑定。
		expect(supervisor.onEvent).not.toHaveBeenCalled();
		// 仍保留 ack 绑定以驱动 REGISTER 流程。
		expect(handlers["ack"] ?? []).toHaveLength(1);
	});

	it("verifyOnly 缺省（稳态）：照常挂载 PI_REQUEST 处理器", () => {
		const { socket, handlers } = fakeSocket();
		const { deps, supervisor } = makeDeps();
		attachPiBridge(socket, deps as never);

		expect(handlers[Events.PI_REQUEST] ?? []).toHaveLength(1);
		expect(supervisor.onEvent).toHaveBeenCalledTimes(1);
	});
});

describe("isMigrationVerifyOnly", () => {
	it("VCPDECK_MIGRATION_VERIFY_ONLY=1 → true；其他 → false", () => {
		expect(isMigrationVerifyOnly({ VCPDECK_MIGRATION_VERIFY_ONLY: "1" })).toBe(true);
		expect(isMigrationVerifyOnly({})).toBe(false);
		expect(isMigrationVerifyOnly({ VCPDECK_MIGRATION_VERIFY_ONLY: "0" })).toBe(false);
	});
});
