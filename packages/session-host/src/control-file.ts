import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";

/**
 * 控制文件内容。
 *
 * 只允许这三个字段：Client 靠它找到宿主端口并用令牌认证。
 * 任何额外字段都会扩大泄露面，因此写入时显式构造记录而不是透传对象。
 */
export interface SessionHostControlFilePayload {
	port: number;
	token: string;
	hostId: string;
}

/** 控制文件写入依赖，供测试注入；生产使用默认实现。 */
export interface ControlFileDeps {
	platform?: NodeJS.Platform;
	/** Windows 上限定文件访问权限；未提供时使用 icacls。 */
	applyWindowsAcl?: (filePath: string, account: string) => Promise<void>;
	/** 临时文件命名；仅在测试断言原子替换时注入。 */
	tempName?: (filePath: string) => string;
}

function assertPayload(payload: SessionHostControlFilePayload): void {
	if (typeof payload !== "object" || payload === null) throw new Error("控制文件负载必须是对象");
	const { port, token, hostId } = payload as unknown as Record<string, unknown>;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("控制文件 port 必须是 1–65535 的整数");
	}
	if (typeof token !== "string" || token.length === 0) throw new Error("控制文件 token 必须是非空字符串");
	if (typeof hostId !== "string" || hostId.length === 0) throw new Error("控制文件 hostId 必须是非空字符串");
}

/**
 * 宿主账户名。宿主与 Client 运行在同一系统级账户下，因此用当前进程账户。
 * 取不到账户时必须失败：不知道归谁所有就不可能正确限定访问。
 */
export function currentHostAccount(env: NodeJS.ProcessEnv = process.env): string {
	const user = env.USERNAME ?? env.USER;
	if (!user) throw new Error("无法确定宿主账户：USERNAME 缺失");
	return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

/**
 * 用 icacls 把控制文件限定为宿主账户可访问，并断开继承。
 *
 * Windows 上 chmod 不产生访问控制效果，因此这里不能把 mode: 0o600 当作隔离。
 */
async function applyWindowsAcl(filePath: string, account: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		// 授权 Modify 而不是 Read：只读会同时剥夺 DELETE，使下一次启动的原子替换必然失败。
		execFile("icacls", [filePath, "/inheritance:r", "/grant:r", `${account}:M`], (error) => {
			if (error) reject(new Error("限制控制文件访问权限失败"));
			else resolve();
		});
	});
}

/**
 * 原子写入控制文件。
 *
 * 先写同目录临时文件再 rename，保证读者永远看不到半截 JSON；
 * 替换失败时清理临时文件并向上抛，绝不留下可疑副本。
 */
export async function writeControlFile(
	filePath: string,
	payload: SessionHostControlFilePayload,
	deps: ControlFileDeps = {},
): Promise<void> {
	assertPayload(payload);
	// 显式构造：额外字段不得进入控制文件。
	const record: SessionHostControlFilePayload = {
		port: payload.port,
		token: payload.token,
		hostId: payload.hostId,
	};
	const tempPath = (deps.tempName ?? ((target) => `${target}.${randomUUID()}.tmp`))(filePath);

	await writeFile(tempPath, JSON.stringify(record), { mode: 0o600 });
	try {
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}

	if ((deps.platform ?? process.platform) === "win32") {
		try {
			await (deps.applyWindowsAcl ?? applyWindowsAcl)(filePath, currentHostAccount());
		} catch (error) {
			// 权限未限定成功就不能留下「看似可用」的控制文件。
			await rm(filePath, { force: true }).catch(() => {});
			throw error;
		}
	}
}
