/**
 * 工具策略的进程内 host bridge（docs/adr/0030 决策 3）。
 *
 * 为什么存在：Pi SDK 0.86.0 没有给扩展任何自定义数据通道（`SessionStartEvent` 无 metadata、
 * `ExtensionContext`/`ExtensionBindings` 无自定义槽位、`ExtensionFactory` 不接收参数），
 * 而随 Bundle 发布的策略扩展又必须拿到 Server 下发的策略。
 *
 * 为什么不用别的通道：
 * - 写磁盘 → 与「Client 不落盘 Server 下发的配置」冲突；
 * - 进程环境变量 → Pi 的 `bash` 工具会派生子进程继承环境，等于把控制面策略暴露给模型可执行的命令。
 *
 * 因此策略只存在于 Worker 进程内的这个对象里，随 Worker 生命周期结束。
 * Bundle 扩展自己实现同样的读取（它是自包含单文件，不能 import 本模块），契约由
 * `PI_TOOL_POLICY_BRIDGE_VERSION` 与 `docs/adr/0030` 固定。
 */
import type { PiToolExecutionMode, PiToolPolicy } from "@vcpdeck/shared";

/** 桥接契约版本；Bundle 扩展与本模块必须一致，否则扩展 fail closed。 */
export const PI_TOOL_POLICY_BRIDGE_VERSION = 2;

/** 全局槽位名（Bundle 扩展按此名读取）。 */
export const PI_TOOL_POLICY_BRIDGE_KEY = "__vcpdeckPiHost";

export interface PiToolPolicyBridge {
	bridgeVersion: number;
	toolPolicy: PiToolPolicy;
	toolExecutionMode: PiToolExecutionMode;
}

type BridgeTarget = Record<string, unknown>;

function isBridge(value: unknown): value is PiToolPolicyBridge {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		bridgeVersion?: unknown;
		toolPolicy?: unknown;
		toolExecutionMode?: unknown;
	};
	return (
		candidate.bridgeVersion === PI_TOOL_POLICY_BRIDGE_VERSION &&
		typeof candidate.toolPolicy === "object" &&
		candidate.toolPolicy !== null &&
		(candidate.toolExecutionMode === "approval" ||
			candidate.toolExecutionMode === "auto" ||
			candidate.toolExecutionMode === "yolo")
	);
}

/** 安装策略与模式桥接；必须在加载 Bundle 扩展之前调用。 */
export function installToolPolicyBridge(
	policy: PiToolPolicy,
	mode: PiToolExecutionMode,
	target: BridgeTarget = globalThis as unknown as BridgeTarget,
): void {
	target[PI_TOOL_POLICY_BRIDGE_KEY] = {
		bridgeVersion: PI_TOOL_POLICY_BRIDGE_VERSION,
		toolPolicy: {
			allow: [...policy.allow],
			confirm: [...policy.confirm],
			deny: [...policy.deny],
		},
		toolExecutionMode: mode,
	} satisfies PiToolPolicyBridge;
}

/** 读取策略与模式桥接；未安装或版本/形状不符返回 null（调用方必须据此 fail closed）。 */
export function readToolPolicyBridge(
	target: BridgeTarget = globalThis as unknown as BridgeTarget,
): PiToolPolicyBridge | null {
	const value = target[PI_TOOL_POLICY_BRIDGE_KEY];
	if (!isBridge(value)) return null;
	return {
		bridgeVersion: value.bridgeVersion,
		toolPolicy: {
			allow: [...value.toolPolicy.allow],
			confirm: [...value.toolPolicy.confirm],
			deny: [...value.toolPolicy.deny],
		},
		toolExecutionMode: value.toolExecutionMode,
	};
}
