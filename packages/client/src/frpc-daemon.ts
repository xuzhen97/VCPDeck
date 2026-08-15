/** @file frpc 守护进程 — 管理单个 frpc 进程，合并所有映射配置 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	Events,
	type FrpCreatePayload,
	type FrpDeletePayload,
} from "@vcpdeck/shared";

interface FrpcProxy {
	mappingId: string;
	name: string;
	type: "tcp" | "http" | "https";
	localIP: string;
	localPort: number;
	remotePort?: number;
	customDomain?: string;
}

interface FrpsInfo {
	serverAddr: string;
	serverPort: number;
	authToken: string;
}

let daemonProcess: ChildProcess | null = null;
const proxies: FrpcProxy[] = [];
let lastFrpsInfo: FrpsInfo | null = null;

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

/** 生成合并的 frpc-combined.toml */
function writeCombinedConfig(frps: FrpsInfo): string {
	const workDir = getWorkDir();
	fs.mkdirSync(workDir, { recursive: true });

	const proxyBlocks = proxies.map((p) => {
		const lines = [
			"[[proxies]]",
			`name = "${p.name}"`,
			`type = "${p.type}"`,
			`localIP = "${p.localIP}"`,
			`localPort = ${p.localPort}`,
		];
		if (typeof p.remotePort === "number" && p.type === "tcp") {
			lines.push(`remotePort = ${p.remotePort}`);
		}
		if (p.customDomain) {
			lines.push(`customDomains = ["${p.customDomain}"]`);
		}
		return lines.join("\n");
	});

	const content =
		[
			`serverAddr = "${frps.serverAddr}"`,
			`serverPort = ${frps.serverPort}`,
			"",
			`auth.method = "token"`,
			`auth.token = "${frps.authToken}"`,
			"",
			...proxyBlocks,
		].join("\n") + "\n";

	const configPath = path.join(workDir, "frpc-combined.toml");
	fs.writeFileSync(configPath, content);
	return configPath;
}

/** 停止当前 frpc 进程 */
function stopFrpc(): void {
	if (!daemonProcess) return;
	try {
		daemonProcess.kill("SIGTERM");
	} catch {
		// 进程已退出或无权限，无需处理
	}
	daemonProcess = null;
}

/** 启动（或重启）frpc */
function startFrpc(frps: FrpsInfo, _socket: SocketLike): void {
	stopFrpc();

	const frpcPath = resolveFrpcPath();
	if (!frpcPath) return;

	const configPath = writeCombinedConfig(frps);
	const workDir = getWorkDir();

	daemonProcess = spawn(frpcPath, ["-c", configPath], {
		cwd: workDir,
		stdio: "pipe",
	});

	daemonProcess.stderr?.on("data", (d: Buffer) => {
		console.log(`[frpc] ${d.toString().trim()}`);
	});

	daemonProcess.on("exit", (code) => {
		console.log(`[frpc] 已退出 (code ${code})`);
		daemonProcess = null;
	});
}

/** 收到 frp.create Job */
export function handleFrpCreate(
	payload: FrpCreatePayload & { _jobId: string },
	socket: SocketLike,
): void {
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

	if (proxies.find((p) => p.mappingId === payload.mappingId)) {
		socket.emit(Events.JOB_DONE, {
			jobId: payload._jobId,
			type: "frp.create",
			error: {
				code: "MAPPING_EXISTS",
				message: `映射 ${payload.mappingId} 已存在`,
			},
		});
		return;
	}

	proxies.push({
		mappingId: payload.mappingId,
		name: payload.name,
		type: payload.proxyType,
		localIP: payload.localIp,
		localPort: payload.localPort,
		remotePort: payload.remotePort,
		customDomain: payload.customDomain,
	});

	lastFrpsInfo = payload.frpsInfo;
	try {
		startFrpc(payload.frpsInfo, socket);
	} catch (e: any) {
		socket.emit(Events.JOB_DONE, {
			jobId: payload._jobId,
			type: "frp.create",
			error: { code: "FRPC_START_FAILED", message: e.message },
		});
		return;
	}

	socket.emit(Events.JOB_DONE, {
		jobId: payload._jobId,
		type: "frp.create",
		result: { mappingId: payload.mappingId, status: "active" },
	});
}

/** 收到 frp.delete Job */
export function handleFrpDelete(
	payload: FrpDeletePayload & { _jobId: string },
	socket: SocketLike,
): void {
	const idx = proxies.findIndex((p) => p.mappingId === payload.mappingId);
	if (idx !== -1) proxies.splice(idx, 1);

	if (proxies.length === 0) {
		stopFrpc();
	} else if (lastFrpsInfo) {
		startFrpc(lastFrpsInfo, socket);
	}

	socket.emit(Events.JOB_DONE, {
		jobId: payload._jobId,
		type: "frp.delete",
		result: { mappingId: payload.mappingId, deleted: true },
	});
}

/** 收到 frp.list Job */
export function handleFrpList(
	payload: { _jobId: string },
	socket: SocketLike,
): void {
	socket.emit(Events.JOB_DONE, {
		jobId: payload._jobId,
		type: "frp.list",
		result: {
			mappings: proxies.map((p) => ({
				id: p.mappingId,
				name: p.name,
				proxyType: p.type,
				localPort: p.localPort,
				remotePort: p.remotePort ?? null,
				status: daemonProcess ? "active" : "inactive",
			})),
		},
	});
}
