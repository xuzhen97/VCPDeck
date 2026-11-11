/**
 * Tailnet 安装矩阵预检（ADR-0062）。
 *
 * 这里只做纯判定，不探测系统、不下载、不写文件；调用方必须把
 * “可以自动安装”当作显式前置条件，而不是默认能力。
 */

/** 计划锁定的 Tailscale 稳定版本；升级必须走独立评审。 */
export const TAILNET_INSTALL_VERSION = "1.104.5";

/** 官方固定材料地址；只允许这两个来源。 */
export const TAILNET_ARTIFACTS = {
	windows: `https://pkgs.tailscale.com/stable/tailscale-setup-${TAILNET_INSTALL_VERSION}-amd64.msi`,
	linux: `https://pkgs.tailscale.com/stable/tailscale_${TAILNET_INSTALL_VERSION}_amd64.tgz`,
} as const;

/** 允许自动安装的目标。 */
export type TailnetInstallTarget =
	| "windows-msi-x64"
	| "linux-static-x64-systemd";

/** 安装矩阵之外统一使用该错误码。 */
export const TAILNET_UNSUPPORTED_PLATFORM = "TAILNET_UNSUPPORTED_PLATFORM";

function unsupported(message: string): Error {
	return Object.assign(new Error(message), {
		code: TAILNET_UNSUPPORTED_PLATFORM,
	});
}

/**
 * 判定当前环境是否落在计划批准的最小安装矩阵内。
 *
 * - Windows 10+/Server 2016+ x64，管理员；
 * - Ubuntu 22.04/24.04、Debian 12/13 x64，root 且 systemd。
 *
 * 其它平台仍可只读探测，但不得自动安装。
 */
export function selectTailnetInstall(
	platform: string,
	arch: string,
	osRelease: Record<string, string>,
	privileged: boolean,
): TailnetInstallTarget {
	if (!privileged) {
		throw unsupported("自动安装需要 root 或管理员权限");
	}
	if (platform === "win32") {
		if (arch !== "x64") {
			throw unsupported("Windows 自动安装仅支持 x64");
		}
		const version = osRelease.VERSION_ID ?? osRelease.VERSION ?? "";
		if (version) {
			const major = Number.parseInt(version.split(".")[0] ?? "", 10);
			if (!Number.isFinite(major) || major < 10) {
				throw unsupported("Windows 自动安装需要 Windows 10 或更高版本");
			}
		}
		return "windows-msi-x64";
	}
	if (platform === "linux") {
		if (arch !== "x64") {
			throw unsupported("Linux 自动安装仅支持 x64");
		}
		const id = (osRelease.ID ?? "").toLowerCase();
		const version = osRelease.VERSION_ID ?? "";
		const ubuntu = id === "ubuntu" && (version === "22.04" || version === "24.04");
		const debian = id === "debian" && (version === "12" || version === "13");
		if (!ubuntu && !debian) {
			throw unsupported("Linux 自动安装仅支持 Ubuntu 22.04/24.04 与 Debian 12/13");
		}
		return "linux-static-x64-systemd";
	}
	throw unsupported(`不支持在 ${platform} 上自动安装 Tailscale`);
}
