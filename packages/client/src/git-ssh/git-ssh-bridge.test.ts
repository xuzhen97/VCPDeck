import type { GitSshAck } from "@vcpdeck/shared";
import { describe, expect, it, vi } from "vitest";
import { attachGitSshBridge, probeGitSshCapability } from "./git-ssh-bridge.js";
import type { GitSshStore } from "./git-ssh-store.js";

const PRIVATE_KEY = [
	"-----BEGIN OPENSSH PRIVATE KEY-----",
	"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
	"-----END OPENSSH PRIVATE KEY-----",
].join("\n");

const PUBLIC_KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7Wv0m0vcpdecktestkey";

function installCommand(version = 1) {
	return {
		protocolVersion: 1,
		operationId: `op-${version}`,
		version,
		action: "install",
		privateKey: PRIVATE_KEY,
		publicKey: PUBLIC_KEY,
	};
}

/** 最小 socket 假实现：只暴露 bridge 依赖的 on/emit。 */
function makeSocket() {
	const handlers = new Map<string, (payload: unknown) => void>();
	const emitted: Array<{ event: string; payload: unknown }> = [];
	return {
		on: (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
		},
		emit: (event: string, payload: unknown) => {
			emitted.push({ event, payload });
		},
		/** 模拟 Server 下发指令。 */
		deliver: (payload: unknown) => handlers.get("git-ssh:command")?.(payload),
		emitted,
		acks: () => emitted.filter((item) => item.event === "git-ssh:ack").map((item) => item.payload as GitSshAck),
	};
}

function makeStore() {
	const store = {
		paths: vi.fn(),
		activeVersion: vi.fn(async () => null),
		hasKey: vi.fn(async () => false),
		install: vi.fn(async () => {}),
		clear: vi.fn(async () => {}),
	};
	return store;
}

describe("attachGitSshBridge", () => {
	it("迁移验证模式不挂载处理器", () => {
		const socket = makeSocket();
		const store = makeStore();
		attachGitSshBridge(socket, { store: store as unknown as GitSshStore, verifyOnly: true });
		socket.deliver(installCommand());
		expect(store.install).not.toHaveBeenCalled();
		expect(socket.emitted).toHaveLength(0);
	});

	it("未完成 REGISTER 前不处理任何指令（不落盘、不回执）", () => {
		const socket = makeSocket();
		const store = makeStore();
		attachGitSshBridge(socket, { store: store as unknown as GitSshStore });
		socket.deliver(installCommand());
		expect(store.install).not.toHaveBeenCalled();
		expect(socket.acks()).toHaveLength(0);
	});

	it("断开后必须重新注册才能处理指令", async () => {
		const socket = makeSocket();
		const store = makeStore();
		const bridge = attachGitSshBridge(socket, {
			store: store as unknown as GitSshStore,
		});
		bridge.markRegistered();
		bridge.markUnregistered();
		expect(bridge.isRegistered()).toBe(false);

		socket.deliver(installCommand());
		await Promise.resolve();
		expect(store.install).not.toHaveBeenCalled();
		expect(socket.emitted).toHaveLength(0);
	});

	it("注册后安装成功回报 installed（operationId/version 一致）", async () => {
		const socket = makeSocket();
		const store = makeStore();
		const bridge = attachGitSshBridge(socket, {
			store: store as unknown as GitSshStore,
		});
		bridge.markRegistered();

		socket.deliver(installCommand(2));
		await vi.waitFor(() => expect(socket.acks()).toHaveLength(1));

		expect(store.install).toHaveBeenCalledWith(
			expect.objectContaining({ version: 2, action: "install" }),
		);
		expect(socket.acks()[0]).toEqual({
			protocolVersion: 1,
			operationId: "op-2",
			version: 2,
			state: "installed",
		});
	});

	it("非法指令一律忽略，不落盘也不回执", async () => {
		const socket = makeSocket();
		const store = makeStore();
		const bridge = attachGitSshBridge(socket, {
			store: store as unknown as GitSshStore,
		});
		bridge.markRegistered();

		socket.deliver({ protocolVersion: 2, operationId: "x", version: 1, action: "clear" });
		socket.deliver({ protocolVersion: 1, operationId: "x", version: 1, action: "rotate" });
		socket.deliver("not-an-object");
		await Promise.resolve();

		expect(store.install).not.toHaveBeenCalled();
		expect(store.clear).not.toHaveBeenCalled();
		expect(socket.emitted).toHaveLength(0);
	});

	it("安装失败回报稳定失败码且不回显原始异常", async () => {
		const socket = makeSocket();
		const store = makeStore();
		store.install.mockRejectedValue(new Error(`EACCES ${PRIVATE_KEY}`));
		const bridge = attachGitSshBridge(socket, {
			store: store as unknown as GitSshStore,
		});
		bridge.markRegistered();

		socket.deliver(installCommand(3));
		await vi.waitFor(() => expect(socket.acks()).toHaveLength(1));

		const ack = socket.acks()[0]!;
		expect(ack).toMatchObject({
			operationId: "op-3",
			version: 3,
			state: "failed",
			code: "GIT_SSH_INSTALL_FAILED",
		});
		expect(JSON.stringify(ack)).not.toContain("BEGIN OPENSSH");
	});

	it("清理成功回报 cleared，失败回报 GIT_SSH_CLEAR_FAILED", async () => {
		const socket = makeSocket();
		const store = makeStore();
		const bridge = attachGitSshBridge(socket, {
			store: store as unknown as GitSshStore,
		});
		bridge.markRegistered();

		socket.deliver({ protocolVersion: 1, operationId: "clr-1", version: 4, action: "clear" });
		await vi.waitFor(() => expect(socket.acks()).toHaveLength(1));
		expect(store.clear).toHaveBeenCalledWith(4);
		expect(socket.acks()[0]).toEqual({
			protocolVersion: 1,
			operationId: "clr-1",
			version: 4,
			state: "cleared",
		});

		store.clear.mockRejectedValue(new Error("EPERM"));
		socket.deliver({ protocolVersion: 1, operationId: "clr-2", version: 4, action: "clear" });
		await vi.waitFor(() => expect(socket.acks()).toHaveLength(2));
		expect(socket.acks()[1]).toMatchObject({
			state: "failed",
			code: "GIT_SSH_CLEAR_FAILED",
		});
	});
});

describe("probeGitSshCapability", () => {
	it("根目录可用时上报协议版本", async () => {
		const store = makeStore();
		store.paths = vi.fn(() => ({ root: process.cwd() })) as never;
		await expect(probeGitSshCapability(store as unknown as GitSshStore)).resolves.toEqual({
			available: true,
			protocolVersion: 1,
		});
	});

	it("根目录不可用时上报稳定原因码", async () => {
		const store = makeStore();
		store.paths = vi.fn(() => ({ root: "/definitely/not/writable/\0root" })) as never;
		await expect(probeGitSshCapability(store as unknown as GitSshStore)).resolves.toEqual({
			available: false,
			code: "GIT_SSH_UNAVAILABLE",
		});
	});

	it("SSH 能力校验失败时不上报可用（fail closed）", async () => {
		const store = makeStore();
		store.paths = vi.fn(() => ({ root: process.cwd() })) as never;
		await expect(
			probeGitSshCapability(store as unknown as GitSshStore, async () => false),
		).resolves.toEqual({ available: false, code: "GIT_SSH_UNAVAILABLE" });
	});
});
