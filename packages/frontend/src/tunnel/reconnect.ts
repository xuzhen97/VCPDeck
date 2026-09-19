/**
 * 远程桌面断线分类与自动重连退避（纯函数）。
 *
 * 现状问题：连上之后断开会被静默处理（回到空闲且不报错），操作者看不到原因。
 * 本模块给出两点确定行为：**能不能重试**、**给什么文案**。
 */
import { friendlyControlPlaneLost, friendlyDesktopError } from "./errors.js";

/** 自动重连次数上限（用户主动断开不计入）。 */
export const MAX_RETRIES = 5;

/** 退避序列（毫秒），超出长度后沿用最后一档。 */
const DELAYS = [1000, 2000, 4000, 8000, 15000] as const;

/** 第 `attempt` 次重试前的等待时长（attempt 从 1 开始；非法值退化为首档）。 */
export function retryDelayMs(attempt: number): number {
	const safe = Number.isFinite(attempt) ? Math.floor(attempt) : 1;
	const index = Math.min(Math.max(safe, 1), DELAYS.length) - 1;
	return DELAYS[index];
}

/**
 * 与"可以再试一次"无关的确定性失败：重试只会重复失败，必须让操作者看到原因。
 * 只列**稳定 code**，未知 code 一律按可重试处理（避免把偶发故障误判为永久失败）。
 */
export const NON_RETRYABLE_CODES = [
	"TUNNEL_CLIENT_UNAVAILABLE",
	"TUNNEL_CLIENT_UNSUPPORTED",
	"TUNNEL_TARGET_REFUSED",
	"TUNNEL_ATTACH_FAILED",
	"TUNNEL_FORBIDDEN",
	"TUNNEL_SESSION_NOT_FOUND",
	"VNC_AUTH_FAILED",
] as const;

export interface DisconnectInput {
	/** 隧道暴露的权威失败码；无则 null。 */
	failureCode: string | null;
	/** 断开前是否已经连接成功过。 */
	wasConnected: boolean;
	/** 是否由用户点击"断开"触发。 */
	userInitiated: boolean;
	/** 是否检测到共享 `/app` socket 掉线。 */
	socketLost: boolean;
}

export interface DisconnectDecision {
	retry: boolean;
	/** 展示给操作者的文案；用户主动断开时为 null（无需提示）。 */
	message: string | null;
}

/** 判定断开原因对应的处理方式。 */
export function classifyDisconnect(input: DisconnectInput): DisconnectDecision {
	if (input.userInitiated) return { retry: false, message: null };
	if (input.socketLost) return { retry: true, message: friendlyControlPlaneLost() };
	if (
		input.failureCode &&
		(NON_RETRYABLE_CODES as readonly string[]).includes(input.failureCode)
	) {
		return { retry: false, message: friendlyDesktopError(input.failureCode) };
	}
	return { retry: true, message: friendlyDesktopError(input.failureCode) };
}
