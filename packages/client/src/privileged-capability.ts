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
	};
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
 * 探测当前运行账户是否具备免密非交互 sudo（仅 Linux；非 Linux 返回 undefined 表示未报告）。
 * 成功（`sudo -n true` 退出码 0）→ sudo-all 可用；失败/超时/异常 → unavailable，失败关闭。
 */
export async function probePrivilegedCapability(
	env: PrivilegedProbeEnv = createDefaultPrivilegedProbeEnv(),
): Promise<PrivilegedCapabilityStatus | undefined> {
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
 * 探测 Client 安装模式（仅 Linux；Windows 返回 undefined 表示未报告，保持原 PM2 语义）。
 * A2 安装通过 `VCPDECK_INSTALLATION_MODE=systemd-root-equivalent` 声明；其余 Linux 视为待迁移 legacy-pm2。
 */
export function detectInstallationInfo(
	env: InstallationProbeEnv = createDefaultInstallationProbeEnv(),
): MachineInstallationStatus | undefined {
	if (env.platform !== "linux") return undefined;
	if (env.installationMode === "systemd-root-equivalent") {
		return { mode: "systemd-root-equivalent" };
	}
	return { mode: "legacy-pm2" };
}
