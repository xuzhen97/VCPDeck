import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import type {
	MachineInstallationStatus,
	PrivilegedCapabilityStatus,
} from "@vcpdeck/shared";

/** 特权能力探测的可注入环境（默认取真实进程环境；测试可整体替换，不触达系统）。 */
export interface PrivilegedProbeEnv {
	readonly platform: NodeJS.Platform;
	readonly currentUser: () => string;
	readonly runNonInteractiveSudo: () => Promise<number>;
	/** Windows 真实身份探测（whoami.exe，无 shell）；返回原始输出，空串表示失败。 */
	readonly runWindowsIdentity: () => Promise<string>;
}

/** 安装模式探测的可注入环境。 */
export interface InstallationProbeEnv {
	readonly platform: NodeJS.Platform;
	readonly installationMode?: string;
}

/** 注册时上报的运行时安全摘要（特权能力 + 安装模式）。 */
export interface RuntimeSecurityInfo {
	privileged?: PrivilegedCapabilityStatus;
	installation?: MachineInstallationStatus;
}

/** sudo 探测固定超时（毫秒）：超时可视为“非交互 sudo 不可用”，失败关闭。 */
const SUDO_PROBE_TIMEOUT_MS = 5_000;

function defaultCurrentUser(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER || process.env.LOGNAME || "unknown";
	}
}

/** 默认探测：无 shell 执行 whoami.exe、固定超时；只取身份文本，不打印任何输出。 */
function defaultRunWindowsIdentity(): Promise<string> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let stdout = "";
		try {
			const child = execFile(
				"whoami.exe",
				[],
				{ timeout: SUDO_PROBE_TIMEOUT_MS, encoding: "utf8" },
				(error) => {
					clearTimeout(timer);
					finish(error ? "" : stdout.trim());
				},
			);
			child.stdout?.on("data", (chunk: unknown) => {
				stdout += String(chunk);
			});
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// 进程已结束：kill 为无操作。
				}
				finish("");
			}, SUDO_PROBE_TIMEOUT_MS);
		} catch {
			finish("");
		}
	});
}

/** 默认探测：非交互、无 shell、固定超时；不捕获、不打印任何凭据或输出。 */
function defaultRunNonInteractiveSudo(): Promise<number> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (code: number) => {
			if (!settled) {
				settled = true;
				resolve(code);
			}
		};
		const child = execFile(
			"sudo",
			["-n", "true"],
			{ timeout: SUDO_PROBE_TIMEOUT_MS },
			(error) => {
				clearTimeout(timer);
				if (!error) {
					finish(0);
					return;
				}
				const code = (error as { code?: unknown }).code;
				finish(typeof code === "number" ? code : 1);
			},
		);
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// 进程已结束：kill 为无操作。
			}
			finish(124);
		}, SUDO_PROBE_TIMEOUT_MS);
	});
}

function createDefaultPrivilegedProbeEnv(): PrivilegedProbeEnv {
	return {
		platform: process.platform,
		currentUser: defaultCurrentUser,
		runNonInteractiveSudo: defaultRunNonInteractiveSudo,
		runWindowsIdentity: defaultRunWindowsIdentity,
	};
}

/** 规范化 whoami 输出为安全可上报的运行账户（去尾部 \r、拒绝控制字符与超长；失败返回 unknown）。 */
function normalizeWindowsIdentity(raw: string): string {
	const value = raw.replace(/\r?\n/g, "").trim();
	// 控制字符（C0）不应出现在账户名中；逐字符判定以避免正则控制字符。
	const hasControlCharacter = [...value].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20);
	if (value.length === 0 || value.length > 256 || hasControlCharacter) return "unknown";
	return value;
}

function createDefaultInstallationProbeEnv(): InstallationProbeEnv {
	return {
		platform: process.platform,
		installationMode: process.env.VCPDECK_INSTALLATION_MODE,
	};
}

function safeRunAsUser(username: string): string {
	return typeof username === "string" && username.length > 0 && username.length <= 256
		? username
		: "unknown";
}

/**
 * 探测当前运行账户的非交互特权能力。
 * Linux：免密 sudo 成功（`sudo -n true` 退出码 0）→ sudo-all；失败/超时/异常 → unavailable，失败关闭。
 * Windows（ADR-0027）：whoami 输出精确为 `NT AUTHORITY\SYSTEM` → windows-system；其他身份、失败或超时 → unavailable。
 * 环境变量只声明安装模式，SYSTEM 权限必须由独立真实身份探测证明，两者互为证据链。
 * 其他平台返回 undefined 表示未报告。
 */
export async function probePrivilegedCapability(
	env: PrivilegedProbeEnv = createDefaultPrivilegedProbeEnv(),
): Promise<PrivilegedCapabilityStatus | undefined> {
	if (env.platform === "win32") {
		let identity = "";
		try {
			identity = await env.runWindowsIdentity();
		} catch {
			identity = "";
		}
		const runAsUser = normalizeWindowsIdentity(identity);
		if (runAsUser.toUpperCase() === "NT AUTHORITY\\SYSTEM") {
			return { available: true, mode: "windows-system", nonInteractive: true, runAsUser: "SYSTEM" };
		}
		return { available: false, mode: "unavailable", nonInteractive: false, runAsUser };
	}
	if (env.platform !== "linux") return undefined;
	let runAsUser: string;
	try {
		runAsUser = safeRunAsUser(env.currentUser());
	} catch {
		runAsUser = "unknown";
	}
	let status = 1;
	try {
		status = await env.runNonInteractiveSudo();
	} catch {
		status = 1;
	}
	if (status === 0) {
		return { available: true, mode: "sudo-all", nonInteractive: true, runAsUser };
	}
	return { available: false, mode: "unavailable", nonInteractive: false, runAsUser };
}

/**
 * 探测 Client 安装模式。
 * Linux：`VCPDECK_INSTALLATION_MODE=systemd-root-equivalent` 声明 A2；其余 Linux 视为待迁移 legacy-pm2。
 * Windows（ADR-0027）：环境值精确为 `windows-system-task` 时上报新模式；其他/缺失均为 legacy-pm2。
 * 其他平台返回 undefined 表示未报告。
 */
export function detectInstallationInfo(
	env: InstallationProbeEnv = createDefaultInstallationProbeEnv(),
): MachineInstallationStatus | undefined {
	if (env.platform === "win32") {
		if (env.installationMode === "windows-system-task") {
			return { mode: "windows-system-task" };
		}
		return { mode: "legacy-pm2" };
	}
	if (env.platform !== "linux") return undefined;
	if (env.installationMode === "systemd-root-equivalent") {
		return { mode: "systemd-root-equivalent" };
	}
	return { mode: "legacy-pm2" };
}
