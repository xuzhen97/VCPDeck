import { describe, expect, it } from "vitest";
import {
	GIT_SSH_FAILURE_CODES,
	GIT_SSH_MAX_TARGETS,
	GIT_SSH_PROTOCOL_VERSION,
	GitSshProtocolError,
	parseGitSshAck,
	parseGitSshCapability,
	parseGitSshCommand,
	parseGitSshTargetInput,
} from "./git-ssh.js";

/** 合法的 OpenSSH 私钥装甲（内容只需通过格式校验）。 */
const PRIVATE_KEY = [
	"-----BEGIN OPENSSH PRIVATE KEY-----",
	"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
	"-----END OPENSSH PRIVATE KEY-----",
].join("\n");

const PUBLIC_KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7Wv0m0vcpdecktestkey";

function install(overrides: Record<string, unknown> = {}) {
	return {
		protocolVersion: GIT_SSH_PROTOCOL_VERSION,
		operationId: "op-1",
		version: 1,
		action: "install",
		privateKey: PRIVATE_KEY,
		publicKey: PUBLIC_KEY,
		...overrides,
	};
}

function clear(overrides: Record<string, unknown> = {}) {
	return {
		protocolVersion: GIT_SSH_PROTOCOL_VERSION,
		operationId: "op-2",
		version: 2,
		action: "clear",
		...overrides,
	};
}

describe("parseGitSshCommand", () => {
	it("解析 install 指令", () => {
		expect(parseGitSshCommand(install())).toEqual({
			protocolVersion: 1,
			operationId: "op-1",
			version: 1,
			action: "install",
			privateKey: PRIVATE_KEY,
			publicKey: PUBLIC_KEY,
		});
	});

	it("解析 clear 指令", () => {
		expect(parseGitSshCommand(clear())).toEqual({
			protocolVersion: 1,
			operationId: "op-2",
			version: 2,
			action: "clear",
		});
	});

	it("未知协议版本、未知 action 与未知字段均拒绝", () => {
		expect(() => parseGitSshCommand(install({ protocolVersion: 2 }))).toThrow(
			GitSshProtocolError,
		);
		expect(() => parseGitSshCommand(install({ action: "rotate" }))).toThrow(
			/action/,
		);
		expect(() => parseGitSshCommand(install({ extra: true }))).toThrow(/未知字段/);
	});

	it("install 与 clear 字段互斥", () => {
		expect(() => parseGitSshCommand(clear({ privateKey: PRIVATE_KEY }))).toThrow(
			/未知字段/,
		);
		const missingKey = install();
		delete (missingKey as Record<string, unknown>).privateKey;
		expect(() => parseGitSshCommand(missingKey)).toThrow(/缺少字段/);
	});

	it("拒绝非 OpenSSH 装甲的私钥与非法公钥", () => {
		expect(() =>
			parseGitSshCommand(install({ privateKey: "just-a-secret" })),
		).toThrow(/私钥/);
		expect(() =>
			parseGitSshCommand(install({ publicKey: "ssh-rsa AAAA" })),
		).toThrow(/公钥/);
	});

	it("拒绝非法 operationId 与 version", () => {
		expect(() => parseGitSshCommand(install({ operationId: "" }))).toThrow(
			/operationId/,
		);
		expect(() => parseGitSshCommand(install({ operationId: "x".repeat(65) }))).toThrow(
			/operationId/,
		);
		expect(() => parseGitSshCommand(install({ version: 0 }))).toThrow(/version/);
		expect(() => parseGitSshCommand(install({ version: 1.5 }))).toThrow(/version/);
	});

	it("错误消息不回显私钥正文", () => {
		try {
			parseGitSshCommand(install({ version: 0 }));
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as Error).message).not.toContain("b3BlbnNzaC1rZXk");
		}
	});
});

describe("parseGitSshAck", () => {
	it("解析 installed / cleared 回执", () => {
		expect(
			parseGitSshAck({
				protocolVersion: 1,
				operationId: "op-1",
				version: 1,
				state: "installed",
			}),
		).toEqual({
			protocolVersion: 1,
			operationId: "op-1",
			version: 1,
			state: "installed",
		});
		expect(
			parseGitSshAck({
				protocolVersion: 1,
				operationId: "op-2",
				version: 2,
				state: "cleared",
			}).state,
		).toBe("cleared");
	});

	it("failed 必须携带已知失败码，成功态不得携带", () => {
		// 判别联合：code 只存在于 failed 分支，断言整个对象比访问 .code 更能锁住契约。
		expect(
			parseGitSshAck({
				protocolVersion: 1,
				operationId: "op-1",
				version: 1,
				state: "failed",
				code: "GIT_SSH_INSTALL_FAILED",
			}),
		).toEqual({
			protocolVersion: 1,
			operationId: "op-1",
			version: 1,
			state: "failed",
			code: "GIT_SSH_INSTALL_FAILED",
		});
		expect(() =>
			parseGitSshAck({
				protocolVersion: 1,
				operationId: "op-1",
				version: 1,
				state: "failed",
			}),
		).toThrow(/code/);
		expect(() =>
			parseGitSshAck({
				protocolVersion: 1,
				operationId: "op-1",
				version: 1,
				state: "failed",
				code: "SOMETHING_ELSE",
			}),
		).toThrow(/code/);
		expect(() =>
			parseGitSshAck({
				protocolVersion: 1,
				operationId: "op-1",
				version: 1,
				state: "installed",
				code: "GIT_SSH_INSTALL_FAILED",
			}),
		).toThrow(/未知字段/);
	});

	it("未知 state 与未知协议版本拒绝", () => {
		expect(() =>
			parseGitSshAck({
				protocolVersion: 1,
				operationId: "op-1",
				version: 1,
				state: "done",
			}),
		).toThrow(/state/);
		expect(() =>
			parseGitSshAck({
				protocolVersion: 9,
				operationId: "op-1",
				version: 1,
				state: "installed",
			}),
		).toThrow(GitSshProtocolError);
	});

	it("失败码枚举只含稳定值", () => {
		expect([...GIT_SSH_FAILURE_CODES]).toEqual([
			"GIT_SSH_KEY_UNAVAILABLE",
			"GIT_SSH_INSTALL_FAILED",
			"GIT_SSH_CLEAR_FAILED",
			"GIT_SSH_UNSUPPORTED",
		]);
	});
});

describe("parseGitSshCapability", () => {
	it("可用能力必须协议版本匹配", () => {
		expect(
			parseGitSshCapability({ available: true, protocolVersion: 1 }),
		).toEqual({ available: true, protocolVersion: 1 });
		expect(() =>
			parseGitSshCapability({ available: true, protocolVersion: 2 }),
		).toThrow(/protocolVersion/);
	});

	it("不可用能力必须携带稳定原因码", () => {
		expect(
			parseGitSshCapability({ available: false, code: "GIT_SSH_UNAVAILABLE" }),
		).toEqual({ available: false, code: "GIT_SSH_UNAVAILABLE" });
		expect(() =>
			parseGitSshCapability({ available: false, code: "NOPE" }),
		).toThrow(/code/);
	});

	it("未知字段与非布尔 available 拒绝", () => {
		expect(() =>
			parseGitSshCapability({ available: true, protocolVersion: 1, extra: 1 }),
		).toThrow(/未知字段/);
		expect(() => parseGitSshCapability({ protocolVersion: 1 })).toThrow(
			/available/,
		);
	});
});

describe("parseGitSshTargetInput", () => {
	it("解析批量目标", () => {
		expect(parseGitSshTargetInput({ clientIds: ["a", "b"] })).toEqual({
			clientIds: ["a", "b"],
		});
		expect(parseGitSshTargetInput({ clientIds: [] })).toEqual({ clientIds: [] });
	});

	it("拒绝重复、非字符串与超上限的目标", () => {
		expect(() => parseGitSshTargetInput({ clientIds: ["a", "a"] })).toThrow(
			/重复/,
		);
		expect(() => parseGitSshTargetInput({ clientIds: [1] })).toThrow(/clientIds/);
		expect(() =>
			parseGitSshTargetInput({
				clientIds: Array.from(
					{ length: GIT_SSH_MAX_TARGETS + 1 },
					(_, index) => `c-${index}`,
				),
			}),
		).toThrow(/数量/);
		expect(() => parseGitSshTargetInput({ clientIds: "a" })).toThrow(/clientIds/);
		expect(() => parseGitSshTargetInput({ targets: ["a"] })).toThrow(/未知字段/);
	});
});
