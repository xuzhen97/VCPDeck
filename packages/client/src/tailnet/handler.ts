/**
 * Tailnet 管理 Job 处理器（ADR-0062）。
 *
 * 只在本机执行受控的探测、官方安装与入网；密钥只经 Server 一次性下发，
 * 并写入短时受限文件后交给 `tailscale up`。任何阶段失败都以稳定错误码回传，
 * 不记录命令输出，不在本地伪造 Server 终态。
 */
import { execFile } from "node:child_process";
import type { JobDispatch } from "@vcpdeck/shared";
import {
	parseTailnetJobPayload,
	type TailnetErrorCode,
	type TailnetJobPayload,
	type TailnetJobResult,
	type TailnetSnapshot,
} from "@vcpdeck/shared";
import { Events } from "@vcpdeck/shared";
import { privileged } from "../privileged-command.js";
import { installTailnet } from "./installer.js";
import { probeTailnet, resolveTailscaleBinary } from "./probe.js";
import { withTailnetSecretFile } from "./secret-file.js";
import type { TailnetSocketBridge } from "./socket-bridge.js";

/** 最小 Socket 面；真实 Socket.IO Socket 满足。 */
export interface TailnetJobSocket {
	emit(event: string, payload: unknown): void;
}

/** 密钥桥中 handler 需要的最小接口。 */
export interface TailnetSecretBridgeLike {
	allowJob(jobId: string): void;
	forgetJob(jobId: string): void;
	request(jobId: string, signal: AbortSignal): Promise<string>;
}

/** `tailscale up` 的结果；输出被丢弃，只保留成败。 */
export interface TailnetJoinResult {
	ok: boolean;
}

/** 可注入依赖；生产默认使用真实探测、安装与子进程。 */
export interface TailnetJobDeps {
	platform: NodeJS.Platform;
	probe: () => Promise<TailnetSnapshot>;
	install: (signal: AbortSignal) => Promise<void>;
	startService: (signal: AbortSignal) => Promise<void>;
	runJoin: (secretPath: string, signal: AbortSignal) => Promise<TailnetJoinResult>;
	requestSecret: (jobId: string, signal: AbortSignal) => Promise<string>;
	allowSecret: (jobId: string) => void;
	forgetSecret: (jobId: string) => void;
	withSecretFile: <T>(
		authKey: string,
		run: (path: string) => Promise<T>,
	) => Promise<T>;
}

/** 在途管理任务；同一时刻只允许一个。 */
const activeJobs = new Map<string, AbortController>();

/** 测试或自定义接线覆盖的生产依赖。 */
let overrides: Partial<TailnetJobDeps> = {};

/** 当前连接的密钥交付桥；未注册时保持为空。 */
let secretBridge: TailnetSecretBridgeLike | null = null;

const SAFE_MESSAGES: Partial<Record<TailnetErrorCode, string>> = {
	TAILNET_CLI_MISSING: "未检测到 Tailscale",
	TAILNET_CLI_FAILED: "Tailscale 命令执行失败",
	TAILNET_PROBE_TIMEOUT: "Tailnet 状态探测超时",
	TAILNET_UNSUPPORTED_PLATFORM: "当前平台不支持自动安装",
	TAILNET_INSTALL_FAILED: "Tailnet 安装失败",
	TAILNET_INSTALL_REBOOT_REQUIRED: "系统需要重启后才能继续",
	TAILNET_EXISTING_CONFIG: "检测到既有 Tailnet 状态，拒绝覆盖",
	TAILNET_JOIN_FAILED: "Tailnet 登录失败",
	TAILNET_SECRET_TIMEOUT: "等待密钥响应超时",
	TAILNET_SECRET_DENIED: "密钥请求被拒绝",
	TAILNET_SECRET_EXPIRED: "密钥已过期",
	TAILNET_SECRET_MISMATCH: "密钥与任务不匹配",
	TAILNET_SECRET_CLEANUP_FAILED: "密钥文件清理失败",
	TAILNET_KEY_BUSY: "凭据正被占用",
	TAILNET_OPERATION_BUSY: "已有 Tailnet 任务在执行",
	TAILNET_OPERATION_MISMATCH: "任务载荷不合法",
};

function errorWithCode(code: TailnetErrorCode, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * 构造固定入网参数：不接管 DNS/路由/SSH/Exit Node，Windows 使用无人值守模式。
 */
export function buildTailnetJoinArgs(
	secretPath: string,
	windows: boolean,
): string[] {
	const args = [
		"up",
		`--auth-key=file:${secretPath}`,
		"--accept-dns=false",
		"--accept-routes=false",
		"--ssh=false",
		"--advertise-exit-node=false",
		"--advertise-routes=",
		"--exit-node=",
		"--timeout=60s",
	];
	if (windows) args.push("--unattended=true");
	return args;
}

function runCommand(
	command: string,
	args: string[],
	signal: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		execFile(
			command,
			args,
			{ timeout: 30_000, signal, windowsHide: true },
			(error) => {
				if (signal.aborted) {
					reject(errorWithCode("TAILNET_SECRET_DENIED", "任务已取消"));
					return;
				}
				if (error) {
					reject(errorWithCode("TAILNET_CLI_FAILED", "命令执行失败"));
					return;
				}
				resolve();
			},
		);
	});
}

async function startTailnetService(signal: AbortSignal): Promise<void> {
	const start =
		process.platform === "win32"
			? privileged("sc.exe", ["start", "Tailscale"])
			: privileged("systemctl", ["start", "tailscaled"]);
	await runCommand(start.command, start.args, signal);
}

function runTailscaleUp(
	secretPath: string,
	signal: AbortSignal,
): Promise<TailnetJoinResult> {
	const join = privileged(
		resolveTailscaleBinary(),
		buildTailnetJoinArgs(secretPath, process.platform === "win32"),
	);
	return new Promise<TailnetJoinResult>((resolve, reject) => {
		execFile(
			join.command,
			join.args,
			{
				timeout: 90_000,
				signal,
				windowsHide: true,
				maxBuffer: 64 * 1024,
			},
			(error) => {
				if (signal.aborted) {
					reject(errorWithCode("TAILNET_SECRET_DENIED", "任务已取消"));
					return;
				}
				// 输出可能包含节点信息，直接丢弃，只保留成败。
				resolve({ ok: !error });
			},
		);
	});
}

function defaultDeps(): TailnetJobDeps {
	return {
		platform: process.platform,
		probe: probeTailnet,
		install: (signal) => installTailnet(signal),
		startService: startTailnetService,
		runJoin: runTailscaleUp,
		requestSecret: (jobId, signal) => {
			if (!secretBridge) {
				return Promise.reject(
					errorWithCode("TAILNET_SECRET_DENIED", "连接尚未注册"),
				);
			}
			return secretBridge.request(jobId, signal);
		},
		allowSecret: (jobId) => secretBridge?.allowJob(jobId),
		forgetSecret: (jobId) => secretBridge?.forgetJob(jobId),
		withSecretFile: (authKey, run) => withTailnetSecretFile(authKey, run),
	};
}

function resolveDeps(): TailnetJobDeps {
	return { ...defaultDeps(), ...overrides };
}

/**
 * 配置管理 Job 依赖；只用于生产接线调整与测试注入。
 */
export function configureTailnetJobDeps(
	next: Partial<TailnetJobDeps>,
): void {
	overrides = { ...overrides, ...next };
}

/** 恢复默认依赖；测试隔离用。 */
export function resetTailnetJobDeps(): void {
	overrides = {};
}

/** 绑定当前连接的密钥桥；断连时应传 null。 */
export function setTailnetSecretBridge(
	bridge: TailnetSecretBridgeLike | null,
): void {
	secretBridge = bridge;
}

/** 在途管理任务 ID 列表，供心跳对账。 */
export function getActiveTailnetJobIds(): string[] {
	return [...activeJobs.keys()];
}

/** 是否存在在途管理任务。 */
export function isTailnetBusy(): boolean {
	return activeJobs.size > 0;
}

/**
 * 取消在途管理任务。
 *
 * 只中止探测/安装/等待密钥/`tailscale up`；已安装的软件与已生效的登录不回滚。
 */
export function cancelTailnetJob(jobId: string): boolean {
	const controller = activeJobs.get(jobId);
	if (!controller) return false;
	controller.abort();
	return true;
}

function emitResult(
	socket: TailnetJobSocket,
	job: JobDispatch,
	result: TailnetJobResult,
): void {
	socket.emit(Events.JOB_DONE, {
		jobId: job.jobId,
		type: job.type,
		result,
	});
}

function emitError(
	socket: TailnetJobSocket,
	job: JobDispatch,
	code: TailnetErrorCode,
): void {
	socket.emit(Events.JOB_DONE, {
		jobId: job.jobId,
		type: job.type,
		error: {
			code,
			message: SAFE_MESSAGES[code] ?? "Tailnet 操作失败",
		},
	});
}

function toErrorCode(error: unknown): TailnetErrorCode {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && code.startsWith("TAILNET_")) {
		return code as TailnetErrorCode;
	}
	return "TAILNET_OPERATION_MISMATCH";
}

function hasExistingIdentity(snapshot: TailnetSnapshot): boolean {
	return (
		snapshot.nodeName !== null ||
		snapshot.ipv4.length > 0 ||
		snapshot.ipv6.length > 0
	);
}

/**
 * 执行一个 Tailnet 管理 Job。
 *
 * inspect 只读；ensure 在确认未登录且无既有身份后才请求密钥并入网。
 * 所有失败都回传稳定错误码，绝不回显命令输出或密钥。
 */
export async function handleTailnetJob(
	job: JobDispatch,
	socket: TailnetJobSocket,
): Promise<void> {
	if (activeJobs.has(job.jobId)) return;
	if (activeJobs.size > 0) {
		emitError(socket, job, "TAILNET_OPERATION_BUSY");
		return;
	}

	const deps = resolveDeps();
	const controller = new AbortController();
	const signal = controller.signal;
	let payload: TailnetJobPayload;
	try {
		payload = parseTailnetJobPayload(
			(job as { payload?: unknown }).payload ?? {},
		);
	} catch {
		emitError(socket, job, "TAILNET_OPERATION_MISMATCH");
		return;
	}

	activeJobs.set(job.jobId, controller);
	let snapshot: TailnetSnapshot | null = null;
	try {
		snapshot = await deps.probe();
		if (payload.action === "inspect") {
			emitResult(socket, job, { stage: "inspected", snapshot });
			return;
		}

		if (snapshot.installed !== "yes") {
			if (!payload.installIfMissing) {
				emitError(socket, job, "TAILNET_CLI_MISSING");
				return;
			}
			await deps.install(signal);
			snapshot = await deps.probe();
			if (snapshot.installed !== "yes") {
				emitError(socket, job, "TAILNET_INSTALL_FAILED");
				return;
			}
		}

		if (snapshot.backend === "running") {
			emitResult(socket, job, { stage: "existing-login", snapshot });
			return;
		}
		if (snapshot.backend === "needs-approval") {
			emitResult(socket, job, { stage: "awaiting-approval", snapshot });
			return;
		}

		// 服务没起来时探测只能给出 stopped/unknown，既看不出登录态也证明不了
		// 未登录。先按需启动服务并重新观测，再决定是否可以安全入网。
		if (snapshot.service !== "running") {
			await deps.startService(signal);
			snapshot = await deps.probe();
			if (snapshot.backend === "running") {
				emitResult(socket, job, { stage: "existing-login", snapshot });
				return;
			}
			if (snapshot.backend === "needs-approval") {
				emitResult(socket, job, { stage: "awaiting-approval", snapshot });
				return;
			}
			if (snapshot.service !== "running") {
				emitError(socket, job, "TAILNET_CLI_FAILED");
				return;
			}
		}

		// 除 needs-login 外的状态（stopped/unknown）无法证明无既有身份，拒绝覆盖。
		if (snapshot.backend !== "needs-login" || hasExistingIdentity(snapshot)) {
			emitError(socket, job, "TAILNET_EXISTING_CONFIG");
			return;
		}

		deps.allowSecret(job.jobId);
		const authKey = await deps.requestSecret(job.jobId, signal);
		const join = await deps.withSecretFile(authKey, (secretPath) =>
			deps.runJoin(secretPath, signal),
		);
		snapshot = await deps.probe();
		if (!join.ok) {
			emitError(socket, job, "TAILNET_JOIN_FAILED");
			return;
		}
		if (snapshot.backend === "running") {
			emitResult(socket, job, { stage: "joined", snapshot });
			return;
		}
		if (snapshot.backend === "needs-approval") {
			emitResult(socket, job, { stage: "awaiting-approval", snapshot });
			return;
		}
		emitError(socket, job, "TAILNET_JOIN_FAILED");
	} catch (error) {
		if (signal.aborted) {
			// 取消后重新探测一次，给 Server 一个可核对的最新观测。
			const recovered = await deps.probe().catch(() => null);
			emitResult(socket, job, {
				stage: "interrupted",
				snapshot: recovered ?? snapshot ?? {
					installed: "unknown",
					version: null,
					service: "unknown",
					backend: "unknown",
					nodeName: null,
					ipv4: [],
					ipv6: [],
					observedAt: new Date().toISOString(),
					errorCode: "TAILNET_CLI_FAILED",
				},
			});
			return;
		}
		emitError(socket, job, toErrorCode(error));
	} finally {
		activeJobs.delete(job.jobId);
		deps.forgetSecret(job.jobId);
	}
}
