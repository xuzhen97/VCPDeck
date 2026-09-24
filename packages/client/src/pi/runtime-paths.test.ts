import { describe, expect, it } from "vitest";
import { resolveVcpPiRuntimePaths } from "./runtime-paths.js";

describe("VcpPiRuntimePaths", () => {
	it("VCPDECK_CLIENT_DATA_DIR 优先于推导路径", () => {
		const p = resolveVcpPiRuntimePaths({
			platform: "linux",
			cwd: "/srv",
			env: {
				VCPDECK_CLIENT_DATA_DIR: "/var/lib/vcpdeck-client",
				VCPDECK_APP_DIR: "/opt/vcpdeck/client",
			},
		});
		expect(p.dataRoot).toBe("/var/lib/vcpdeck-client");
		expect(p.piRoot).toBe("/var/lib/vcpdeck-client/pi");
		expect(p.agentDir).toBe("/var/lib/vcpdeck-client/pi/agent");
		expect(p.sessionsRoot).toBe("/var/lib/vcpdeck-client/pi/sessions");
		expect(p.installSecretPath).toBe("/var/lib/vcpdeck-client/pi/install-secret");
	});

	it("无显式变量时回退到 VCPDECK_APP_DIR/data", () => {
		const p = resolveVcpPiRuntimePaths({
			platform: "linux",
			cwd: "/tmp/dev",
			env: { VCPDECK_APP_DIR: "/opt/vcpdeck/client" },
		});
		expect(p.dataRoot).toBe("/opt/vcpdeck/client/data");
	});

	it("无 VCPDECK_APP_DIR 时回退到 cwd/data，并使用 win32 路径语义", () => {
		const p = resolveVcpPiRuntimePaths({
			platform: "win32",
			cwd: "C:\\dev\\vcpdeck",
			env: {},
		});
		expect(p.dataRoot).toBe("C:\\dev\\vcpdeck\\data");
		expect(p.agentDir).toBe("C:\\dev\\vcpdeck\\data\\pi\\agent");
		expect(p.sessionsRoot).toBe("C:\\dev\\vcpdeck\\data\\pi\\sessions");
	});

	it("Windows SYSTEM 安装路径解析为 ProgramData 下的 data 目录", () => {
		const p = resolveVcpPiRuntimePaths({
			platform: "win32",
			cwd: "C:\\dev",
			env: {
				VCPDECK_APP_DIR: "C:\\ProgramData\\VCPDeck\\Client",
				VCPDECK_CLIENT_DATA_DIR: "C:\\ProgramData\\VCPDeck\\Client\\data",
			},
		});
		expect(p.agentDir).toBe("C:\\ProgramData\\VCPDeck\\Client\\data\\pi\\agent");
	});

	it("dataRoot 落在版本目录内时 fail closed", () => {
		expect(() =>
			resolveVcpPiRuntimePaths({
				platform: "linux",
				cwd: "/opt/vcpdeck/client",
				env: {
					VCPDECK_APP_DIR: "/opt/vcpdeck/client",
					VCPDECK_CLIENT_DATA_DIR: "/opt/vcpdeck/client/apps/0.11.0/data",
				},
			}),
		).toThrow(/版本目录/);
	});

	it("Windows 下大小写不同的版本目录同样被拒绝", () => {
		expect(() =>
			resolveVcpPiRuntimePaths({
				platform: "win32",
				cwd: "C:\\ProgramData\\VCPDeck\\Client",
				env: {
					VCPDECK_APP_DIR: "C:\\ProgramData\\VCPDeck\\Client",
					VCPDECK_CLIENT_DATA_DIR: "c:\\programdata\\vcpdeck\\client\\apps\\0.11.0\\data",
				},
			}),
		).toThrow(/版本目录/);
	});

	it("绝不返回用户 Pi 路径", () => {
		const p = resolveVcpPiRuntimePaths({
			platform: "linux",
			cwd: "/srv",
			env: { HOME: "/home/operator" },
		});
		const serialized = JSON.stringify(p);
		expect(serialized).not.toContain("/.pi");
		expect(serialized).not.toContain("/home/operator");
	});
});
