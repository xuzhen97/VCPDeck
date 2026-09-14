/**
 * 把具体进程适配为 Supervisor 可监管的组件。
 *
 * 目前只适配既有单构件 `Daemon`（TypeScript Client 或 Server）。
 * Desktop Host、Session Helper 需要 Task 9–12 的平台后端与本机 IPC 健康探测，
 * 落地后它们会以同样的 `SupervisedComponent` 形状加入同一列表——不在这里
 * 用占位组件假装已经监管了它们。
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { Daemon } from "./daemon.js";
import type { SupervisedComponent } from "./supervisor.js";

/** 把单构件 Daemon 适配为可监管组件。 */
export function createDaemonComponent(
	daemon: Daemon,
	name: string,
): SupervisedComponent {
	return {
		name,
		start: () => daemon.start(),
		stop: () => daemon.stopSupervised(),
		check: () => daemon.healthCheck(),
	};
}

export interface ChildProcessComponentOptions {
	name: string;
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	/** 优雅停止等待上限；超时后强杀。 */
	stopTimeoutMs?: number;
}

/**
 * 监管一个子进程（用于 Desktop Host、Session Helper 等本机二进制）。
 *
 * 健康检查**只**回答“进程是否仍在运行”。能力级探测（Host IPC 可达、
 * 捕获可用、WebRTC loopback 成功）必须由各自的组件实现提供，不能在这里
 * 用存活状态冒充。
 */
export function createChildProcessComponent(
	options: ChildProcessComponentOptions,
): SupervisedComponent {
	const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
	let child: ChildProcess | null = null;
	let stopping = false;
	const log = options.log ?? (() => undefined);

	return {
		name: options.name,
		start: async () => {
			stopping = false;
			const spawned = spawn(options.command, [...(options.args ?? [])], {
				cwd: options.cwd,
				env: { ...process.env, ...options.env },
				stdio: "inherit",
				windowsHide: true,
			});
			// 必须等 'spawn' 事件才认为启动成功：二进制缺失（ENOENT）等错误是
			// 异步发出的，若立即 resolve，Supervisor 会把从未启动的组件当成
			// running，也就不会回滚。
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => reject(error);
				spawned.once("spawn", () => {
					spawned.off("error", onError);
					resolve();
				});
				spawned.once("error", onError);
			});
			child = spawned;
			// 子进程退出后清空引用，健康检查据此判定为不健康。
			spawned.once("exit", () => {
				if (!stopping) log(`[supervisor] ${options.name} 子进程已退出`);
				child = null;
			});
			// 派生成功之后的运行期错误：记录并视为不健康，不抛出未捕获异常。
			spawned.on("error", (error: Error) => {
				log(`[supervisor] ${options.name} 运行期错误: ${error.message}`);
				child = null;
			});
		},
		stop: async () => {
			const current = child;
			if (!current) return;
			stopping = true;
			child = null;
			current.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					try {
						current.kill("SIGKILL");
					} catch {
						// 进程可能已退出
					}
					resolve();
				}, stopTimeoutMs);
				current.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
		check: async () => (child ? null : `${options.name} 子进程未运行`),
	};
}
