/** @file frpc 守护进程 — 单例适配器：把 FrpRuntimeManager 结果映射为 JOB_DONE，管理真实 frpc spawn 与原子 TOML 替换 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	Events,
	parseFrpReconcilePayload,
	type FrpCreatePayload,
	type FrpDeletePayload,
	type FrpListResult,
	type FrpReconcilePayload,
	type FrpReconcileResult,
	type FrpRuntimeStateReport,
} from "@vcpdeck/shared";
import {
	createFrpRuntimeManager,
	type FrpRuntimeManager,
} from "./frp-runtime-manager.js";
// 调用期访问 CLIENT_ID（模块求值期避免与 register 的循环依赖）。
import { CLIENT_ID } from "./register.js";

type SocketLike = {
	emit: (event: string, data: unknown) => void;
};

/** 默认 frpc 路径候选（按序尝试，支持 .bin 副本：防 Windows 开发机杀毒删除无扩展名 ELF） */
function defaultFrpcPath(): string | null {
	const platform = os.platform();
	const arch = os.arch();
	const map: Record<string, string[]> = {
		"win32-x64": ["frp/win-x64/frpc.exe"],
		"linux-x64": ["frp/linux-x64/frpc", "frp/linux-x64/frpc.bin"],
		"linux-arm64": ["frp/linux-arm64/frpc", "frp/linux-arm64/frpc.bin"],
	};
	const rels = map[`${platform}-${arch}`];
	if (!rels) return null;
	for (const rel of rels) {
		const candidate = path.join(__dirname, rel);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function resolveFrpcPath(): string | null {
	const envPath = process.env.VCPDECK_FRPC_PATH;
	if (envPath && fs.existsSync(envPath)) return envPath;
	const def = defaultFrpcPath();
	if (def && fs.existsSync(def)) return def;
	return null;
}

export function isFrpAvailable(): boolean {
	return resolveFrpcPath() !== null;
}

function getWorkDir(): string {
	return (
		process.env.VCPDECK_FRPC_WORK_DIR ||
		path.join(os.homedir(), ".vcpdeck", "frp")
	);
}

/** 原子写合并 TOML：tmp-<generation> 写入后 rename 到正式文件；权限沿用运行账户，内容不落日志。 */
function writeCombinedConfigAtomically(content: string): string {
	const workDir = getWorkDir();
	fs.mkdirSync(workDir, { recursive: true });
	const configPath = path.join(workDir, "frpc-combined.toml");
	const tmpPath = path.join(
		workDir,
		`frpc-combined.toml.tmp-${Date.now().toString(36)}`,
	);
	fs.writeFileSync(tmpPath, content);
	fs.renameSync(tmpPath, configPath);
	return configPath;
}

let manager: FrpRuntimeManager | null = null;

/** 懒加载单例 manager（真实 spawn/FS；clientId 取本机持久化 ID）。 */
function getManager(): FrpRuntimeManager {
	if (!manager) {
		manager = createFrpRuntimeManager({
			resolveExecutable: () => resolveFrpcPath(),
			workDir: getWorkDir(),
			spawn: (cmd, args, opts) => {
				const child = spawn(cmd, args, opts as never) as never;
				return child;
			},
			writeConfigAtomically: (content) => {
				writeCombinedConfigAtomically(content);
			},
			// 在线崩溃有限重启：立即 / 5s / 30s，共三次。
			delays: [0, 5_000, 30_000],
			clientId: CLIENT_ID,
			onState: () => {
				// 上报由 socket 桥订阅（subscribeFrpRuntimeState）驱动，这里无需副作用。
			},
			log: (msg) => console.log(msg),
		});
	}
	return manager;
}

/** 获取 FRP 运行时单例（socket 桥接线用）。 */
export function getFrpRuntimeManager(): FrpRuntimeManager {
	return getManager();
}

/** 当前 FRP 运行时安全状态快照（不含 Token/TOML/stderr）。 */
export function getFrpRuntimeState(clientId: string): FrpRuntimeStateReport {
	return getManager().getStateReport(clientId);
}

/** 设置当前 socket 连接代次（每次 REGISTER 生成新 UUID 后调用）。 */
export function setFrpConnectionGeneration(value: string): void {
	getManager().setConnectionGeneration(value);
}

/** 订阅 FRP 运行时状态变化；返回退订函数。 */
export function subscribeFrpRuntimeState(
	listener: (report: FrpRuntimeStateReport) => void,
): () => void {
	return getManager().subscribe(listener);
}

/** 计划内停机：取消有限重启 timer 并停止 frpc（更新/退出前调用，防误判 crash）。 */
export async function shutdownFrpRuntime(): Promise<void> {
	await getManager().shutdown();
}

function reconcileErrorCode(err: unknown): string {
	const code = (err as { code?: string } | null)?.code;
	if (code === "FRP_RUNTIME_GENERATION_STALE") return code;
	if (code === "FRP_RUNTIME_STATE_INVALID") return code;
	const msg = err instanceof Error ? err.message : "";
	if (msg.includes("frpc 二进制不存在")) return "FRPC_NOT_FOUND";
	if (msg.includes("frpc 启动失败")) return "FRPC_START_FAILED";
	return "FRP_RECONCILE_FAILED";
}

/** 收到 frp.create Job */
export async function handleFrpCreate(
	payload: FrpCreatePayload & { _jobId: string },
	socket: SocketLike,
): Promise<void> {
	if (!isFrpAvailable()) {
		socket.emit(Events.JOB_DONE, {
			jobId: payload._jobId,
			type: "frp.create",
			error: {
				code: "FRPC_NOT_FOUND",
				message: "frpc 二进制不存在",
			},
		});
		return;
	}

	try {
		const result = await getManager().create(payload);
		socket.emit(Events.JOB_DONE, {
			jobId: payload._jobId,
			type: "frp.create",
			result,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		const code =
			message.includes("MAPPING_EXISTS") ? "MAPPING_EXISTS" : "FRPC_START_FAILED";
		socket.emit(Events.JOB_DONE, {
			jobId: payload._jobId,
			type: "frp.create",
			error: {
				code,
				message:
					code === "MAPPING_EXISTS"
						? `映射 ${payload.mappingId} 已存在`
						: "frpc 启动失败",
			},
		});
	}
}

/** 收到 frp.delete Job */
export async function handleFrpDelete(
	payload: FrpDeletePayload & { _jobId: string },
	socket: SocketLike,
): Promise<void> {
	try {
		const result = await getManager().delete(payload);
		socket.emit(Events.JOB_DONE, {
			jobId: payload._jobId,
			type: "frp.delete",
			result,
		});
	} catch {
		socket.emit(Events.JOB_DONE, {
			jobId: payload._jobId,
			type: "frp.delete",
			error: { code: "FRPC_START_FAILED", message: "frpc 启动失败" },
		});
	}
}

/** 收到 frp.reconcile Job（严格解析 payload；Client 不在 Job 内重试） */
export async function handleFrpReconcile(
	payload: { _jobId: string } & Record<string, unknown>,
	socket: SocketLike,
): Promise<void> {
	const jobId = payload._jobId;
	let parsed: FrpReconcilePayload;
	try {
		// 去掉 _jobId 后严格解析（未知字段拒绝）。
		const { _jobId: _omitted, ...rest } = payload;
		parsed = parseFrpReconcilePayload(rest);
	} catch {
		socket.emit(Events.JOB_DONE, {
			jobId,
			type: "frp.reconcile",
			error: {
				code: "FRP_RUNTIME_STATE_INVALID",
				message: "frp reconcile 协议无效",
			},
		});
		return;
	}

	try {
		const result: FrpReconcileResult = await getManager().reconcile(parsed);
		socket.emit(Events.JOB_DONE, { jobId, type: "frp.reconcile", result });
	} catch (err) {
		socket.emit(Events.JOB_DONE, {
			jobId,
			type: "frp.reconcile",
			error: {
				code: reconcileErrorCode(err),
				message: "frp reconcile 失败",
			},
		});
	}
}

/** 收到 frp.list Job */
export function handleFrpList(
	payload: { _jobId: string },
	socket: SocketLike,
): void {
	const result: FrpListResult = getManager().list();
	socket.emit(Events.JOB_DONE, {
		jobId: payload._jobId,
		type: "frp.list",
		result,
	});
}
