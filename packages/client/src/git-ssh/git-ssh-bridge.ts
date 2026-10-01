/**
 * Git SSH 受管密钥 Socket 桥（Client 侧）。
 *
 * 权威边界见 docs/adr/0037 决策 2/3 与 docs/adr/0038：
 * - 只有 Server 主动下发的、经严格解析的指令才会被处理；
 * - REGISTER 完成前不处理任何指令（不落盘、不回执）；
 * - 回执只含安全状态与稳定失败码，绝不回显私钥或原始异常正文；
 * - `installed`/`cleared` 只表示本地受管副本状态，不代表 Git 服务侧授权状态。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	Events,
	GIT_SSH_PROTOCOL_VERSION,
	parseGitSshCommand,
	type GitSshAck,
	type GitSshCapability,
	type GitSshCommand,
	type GitSshFailureCode,
} from "@vcpdeck/shared";
import type { GitSshStore } from "./git-ssh-store.js";

/** bridge 依赖的最小 socket 面（真实 Socket.IO 客户端满足）。 */
export interface GitSshSocket {
	on(event: string, handler: (payload: unknown) => void): void;
	emit(event: string, payload: unknown): void;
}

export interface GitSshBridgeOptions {
	store: GitSshStore;
	/** 迁移验证模式（ADR-0027 M1）：不挂载处理器。 */
	verifyOnly?: boolean;
	/** 供测试注入；缺省投递失败不影响安装结果。 */
	onAck?: (ack: GitSshAck) => void;
}

export interface GitSshBridge {
	/** REGISTER ack 之后调用：此后才允许处理 Server 指令。 */
	markRegistered(): void;
	/** 连接断开后调用：新连接必须重新注册才能处理指令。 */
	markUnregistered(): void;
	/** 未注册前不回执；返回 false 便于调用方诊断。 */
	isRegistered(): boolean;
}

/** 回执构造：成功态不带失败码，失败态必须带稳定失败码（与 `GitSshAck` 判别联合一致）。 */
function ackState(
	target: GitSshSocket,
	command: GitSshCommand,
	onAck: GitSshBridgeOptions["onAck"],
	state: "installed" | "cleared",
): void {
	const ack: GitSshAck = {
		protocolVersion: GIT_SSH_PROTOCOL_VERSION,
		operationId: command.operationId,
		version: command.version,
		state,
	};
	onAck?.(ack);
	target.emit(Events.GIT_SSH_ACK, ack);
}

function ackFailure(
	target: GitSshSocket,
	command: GitSshCommand,
	onAck: GitSshBridgeOptions["onAck"],
	code: GitSshFailureCode,
): void {
	const ack: GitSshAck = {
		protocolVersion: GIT_SSH_PROTOCOL_VERSION,
		operationId: command.operationId,
		version: command.version,
		state: "failed",
		code,
	};
	onAck?.(ack);
	target.emit(Events.GIT_SSH_ACK, ack);
}

export function attachGitSshBridge(
	target: GitSshSocket,
	options: GitSshBridgeOptions,
): GitSshBridge {
	let registered = false;

	const bridge: GitSshBridge = {
		markRegistered: () => {
			registered = true;
		},
		markUnregistered: () => {
			registered = false;
		},
		isRegistered: () => registered,
	};

	// 迁移验证模式：不挂载任何处理器（不下发、不落盘、不回执）。
	if (options.verifyOnly === true) return bridge;

	target.on(Events.GIT_SSH_COMMAND, (payload: unknown) => {
		void (async () => {
			if (!registered) return;
			let command: GitSshCommand;
			try {
				command = parseGitSshCommand(payload);
			} catch {
				// 未知版本/字段/长度一律忽略：不落盘、不回执（fail closed）。
				return;
			}

			if (command.action === "install") {
				try {
					await options.store.install(command);
					ackState(target, command, options.onAck, "installed");
				} catch {
					// 只回稳定失败码，不携带原始异常、路径或私钥正文。
					ackFailure(
						target,
						command,
						options.onAck,
						"GIT_SSH_INSTALL_FAILED",
					);
				}
				return;
			}

			try {
				await options.store.clear(command.version);
				ackState(target, command, options.onAck, "cleared");
			} catch {
				ackFailure(target, command, options.onAck, "GIT_SSH_CLEAR_FAILED");
			}
		})();
	});

	return bridge;
}

/**
 * 探测本机是否可承担受管密钥分发。
 *
 * 只有「受管根目录可写」且（可选）「SSH 能实行要求的主机校验」都成立时才上报可用；
 * 任一不成立即上报稳定原因码，Server 因此不下发密钥。
 */
export async function probeGitSshCapability(
	store: GitSshStore,
	verifySsh?: () => Promise<boolean>,
): Promise<GitSshCapability> {
	try {
		const root = store.paths().root;
		await mkdir(root, { recursive: true });
		// 真实写入探测：目录存在不代表可写（Windows ACL 收紧后尤其重要）。
		const probePath = join(root, `.probe-${randomUUID()}`);
		await writeFile(probePath, "probe", { mode: 0o600 });
		await rm(probePath, { force: true });
	} catch {
		return { available: false, code: "GIT_SSH_UNAVAILABLE" };
	}
	if (verifySsh) {
		try {
			if (!(await verifySsh())) {
				return { available: false, code: "GIT_SSH_UNAVAILABLE" };
			}
		} catch {
			return { available: false, code: "GIT_SSH_UNAVAILABLE" };
		}
	}
	return { available: true, protocolVersion: GIT_SSH_PROTOCOL_VERSION };
}
