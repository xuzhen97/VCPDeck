/**
 * Tailnet 安装矩阵预检单测（ADR-0062）。
 *
 * 只用纯函数判定平台/架构/特权，任何副作用都必须在返回可安装目标之后。
 */
import { describe, expect, it } from "vitest";
import {
	selectTailnetInstall,
	TAILNET_ARTIFACTS,
	TAILNET_INSTALL_VERSION,
} from "./platform.js";

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return (error as { code?: string }).code ?? "NO_CODE";
	}
	return "NO_THROW";
}

describe("Tailnet 安装矩阵", () => {
	it("Windows x64 + 管理员 → 官方 MSI", () => {
		expect(selectTailnetInstall("win32", "x64", {}, true)).toBe(
			"windows-msi-x64",
		);
	});

	it("Ubuntu 22.04/24.04 x64 + root → 官方静态包 + systemd", () => {
		expect(
			selectTailnetInstall("linux", "x64", { ID: "ubuntu", VERSION_ID: "22.04" }, true),
		).toBe("linux-static-x64-systemd");
		expect(
			selectTailnetInstall("linux", "x64", { ID: "ubuntu", VERSION_ID: "24.04" }, true),
		).toBe("linux-static-x64-systemd");
	});

	it("Debian 12/13 x64 + root → 官方静态包 + systemd", () => {
		expect(
			selectTailnetInstall("linux", "x64", { ID: "debian", VERSION_ID: "12" }, true),
		).toBe("linux-static-x64-systemd");
		expect(
			selectTailnetInstall("linux", "x64", { ID: "debian", VERSION_ID: "13" }, true),
		).toBe("linux-static-x64-systemd");
	});

	it("非白名单发行版、非 x64、非 root/管理员一律拒绝", () => {
		expect(
			codeOf(() =>
				selectTailnetInstall("linux", "arm64", { ID: "alpine" }, true),
			),
		).toBe("TAILNET_UNSUPPORTED_PLATFORM");
		expect(
			codeOf(() =>
				selectTailnetInstall("linux", "x64", { ID: "ubuntu", VERSION_ID: "20.04" }, true),
			),
		).toBe("TAILNET_UNSUPPORTED_PLATFORM");
		expect(
			codeOf(() =>
				selectTailnetInstall("linux", "x64", { ID: "ubuntu", VERSION_ID: "22.04" }, false),
			),
		).toBe("TAILNET_UNSUPPORTED_PLATFORM");
		expect(codeOf(() => selectTailnetInstall("win32", "x64", {}, false))).toBe(
			"TAILNET_UNSUPPORTED_PLATFORM",
		);
	});

	it("固定版本与官方材料地址不受调用方影响", () => {
		expect(TAILNET_INSTALL_VERSION).toBe("1.104.5");
		expect(TAILNET_ARTIFACTS.windows).toBe(
			"https://pkgs.tailscale.com/stable/tailscale-setup-1.104.5-amd64.msi",
		);
		expect(TAILNET_ARTIFACTS.linux).toBe(
			"https://pkgs.tailscale.com/stable/tailscale_1.104.5_amd64.tgz",
		);
	});
});
