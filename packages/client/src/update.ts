/**
 * 客户端有界 drain 与 Launcher 两阶段更新处理。
 * 详见 docs/design/release-and-update.md。
 * 收到 update:request 后：
 *   1) 调本机 launcher /prepare（下载/校验/解压）
 *   2) 拒新 job（draining 标志，dispatcher 守卫）
 *   3) 等运行中 job 完成（超时强制继续）
 *   4) 回 update:ready → 调 launcher /apply（launcher 停掉本进程并切换）
 */
import { Events, type UpdateFailed, type UpdateReady } from "@vcpdeck/shared";
import type { Socket } from "socket.io-client";
import { CLIENT_ID } from "./register.js";
import { getRunningJobIds } from "./executor.js";
import type { ClientLauncher } from "./launcher-control.js";

let draining = false;

/** 客户端是否处于更新停机中（dispatcher 据此拒绝新任务） */
export function isDraining(): boolean {
	return draining;
}

export interface ClientUpdateDeps {
	socket: Socket;
	launcher: ClientLauncher;
	/** 服务端基址（相对下载 URL 解析用） */
	serverBase: string;
	/** 运行中 job 查询（测试注入） */
	getRunningJobIds?: () => string[];
	pollIntervalMs?: number;
	log?: (msg: string) => void;
	/** 就绪回执后、apply 前释放本地实时资源（如 frpc 计划内停机；失败不阻断更新）。 */
	beforeApply?: () => Promise<void>;
}

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 注册 update:request 处理；返回解绑函数 */
export function attachUpdateHandler(deps: ClientUpdateDeps): () => void {
	const handler = (req: never) => {
		void handleUpdateRequest(req, deps);
	};
	deps.socket.on(Events.UPDATE_REQUEST, handler as never);
	return () => {
		deps.socket.off(Events.UPDATE_REQUEST, handler as never);
	};
}

async function handleUpdateRequest(
	req: {
		releaseVersion?: string;
		url?: string;
		sha256?: string;
		timeoutMs?: number;
	},
	deps: ClientUpdateDeps,
): Promise<void> {
	if (draining) return; // 已在更新流程，忽略重复请求
	const log = deps.log ?? ((msg: string) => console.log(`[update] ${msg}`));

	if (!req.releaseVersion || !req.url || !req.sha256) {
		emitFailed(deps, req.releaseVersion ?? "unknown", "update:request 缺少字段");
		return;
	}

	draining = true;
	const releaseVersion = req.releaseVersion;
	try {
		// 1) launcher 准备新版本（相对 URL 解析为完整地址）
		const fullUrl = new URL(req.url, deps.serverBase).toString();
		await deps.launcher.prepareUpdate({
			version: releaseVersion,
			url: fullUrl,
			sha256: req.sha256,
		});
		log(`新版本已就绪: ${releaseVersion}`);

		// 2) 优雅停机：等运行中 job 完成（超时强制继续）
		const deadline = Date.now() + (req.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
		const runningIds = deps.getRunningJobIds ?? getRunningJobIds;
		while (runningIds().length > 0 && Date.now() < deadline) {
			await sleep(deps.pollIntervalMs ?? 500);
		}

		// 3) 就绪回执 → 本地实时资源计划内释放 → launcher 接管
		deps.socket.emit(Events.UPDATE_READY, {
			clientId: CLIENT_ID,
			releaseVersion,
		} satisfies UpdateReady);
		try {
			await deps.beforeApply?.();
		} catch {
			log("beforeApply 释放失败（不阻断更新）");
		}
		await deps.launcher.applyUpdate();
		// apply 后本进程应被 launcher 停止；连接被掐断与「进程仍存活」无法
		// 可靠区分，不在此上报失败——终局以重连注册版本为准。
	} catch (e) {
		emitFailed(deps, releaseVersion, e instanceof Error ? e.message : String(e));
	} finally {
		draining = false;
	}
}

function emitFailed(
	deps: ClientUpdateDeps,
	releaseVersion: string,
	reason: string,
): void {
	deps.socket.emit(Events.UPDATE_FAILED, {
		clientId: CLIENT_ID,
		releaseVersion,
		reason,
	} satisfies UpdateFailed);
}
