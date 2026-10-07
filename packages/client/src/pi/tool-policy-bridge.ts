/**
 * 执行模式的进程内 host bridge（ADR-0030 决策 3、ADR-0039 决策 4）。
 *
 * 为什么存在：Pi SDK 0.86.0 没有给扩展任何自定义数据通道（`SessionStartEvent` 无 metadata、
 * `ExtensionContext`/`ExtensionBindings` 无自定义槽位、`ExtensionFactory` 不接收参数），
 * 而随 Bundle 发布的执行模式扩展又必须拿到 Server 下发的模式。
 *
 * 为什么不用别的通道：
 * - 写磁盘 → 与「Client 不落盘 Server 下发的配置」冲突；
 * - 进程环境变量 → Pi 的 `bash` 工具会派生子进程继承环境，等于把控制面配置暴露给模型可执行的命令。
 *
 * 因此模式只存在于 Worker 进程内的这个对象里，随 Worker 生命周期结束。
 * Bundle 扩展自己实现同样的读取（它是自包含单文件，不能 import 本模块），契约由
 * `PI_TOOL_POLICY_BRIDGE_VERSION` 与 `docs/adr/0039` 固定。
 *
 * v3 相对 v2 的变化：**删除 `toolPolicy` 三桶**，只携带 `toolExecutionMode`（两值）。
 */
import type { PiToolExecutionMode } from "@vcpdeck/shared";

/** 桥接契约版本；Bundle 扩展与本模块必须一致，否则扩展 fail closed。 */
export const PI_TOOL_POLICY_BRIDGE_VERSION = 3;

/** 全局槽位名（Bundle 扩展按此名读取）。 */
export const PI_TOOL_POLICY_BRIDGE_KEY = "__vcpdeckPiHost";

export interface PiToolPolicyBridge {
	bridgeVersion: number;
	toolExecutionMode: PiToolExecutionMode;
}

type BridgeTarget = Record<string, unknown>;

/**
 * 默认桥接载体：`globalThis`。
 *
 * 所有读取路径仍经 `isBridge` 运行时校验，断言不用于绕过校验。
 */
function defaultBridgeTarget(): BridgeTarget {
	// SAFETY: `globalThis` 是任意可写属性宿主，结构上满足 `Record<string, unknown>`；
	// TS 无法直接推导全局对象的索引签名，此处断言仅用于标注“把全局对象当作可写命名槽”。
	return globalThis as unknown as BridgeTarget;
}

function isExecutionMode(value: unknown): value is PiToolExecutionMode {
	return value === "supervised" || value === "automatic";
}

function isBridge(value: unknown): value is PiToolPolicyBridge {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		bridgeVersion?: unknown;
		toolExecutionMode?: unknown;
	};
	return (
		candidate.bridgeVersion === PI_TOOL_POLICY_BRIDGE_VERSION &&
		isExecutionMode(candidate.toolExecutionMode)
	);
}

/** 安装执行模式桥接；必须在加载 Bundle 扩展之前调用。 */
export function installToolPolicyBridge(
	mode: PiToolExecutionMode,
	target: BridgeTarget = defaultBridgeTarget(),
): void {
	target[PI_TOOL_POLICY_BRIDGE_KEY] = {
		bridgeVersion: PI_TOOL_POLICY_BRIDGE_VERSION,
		toolExecutionMode: mode,
	} satisfies PiToolPolicyBridge;
}

/** 读取模式桥接；未安装或版本/形状不符返回 null（调用方必须据此 fail closed）。 */
export function readToolPolicyBridge(
	target: BridgeTarget = defaultBridgeTarget(),
): PiToolPolicyBridge | null {
	const value = target[PI_TOOL_POLICY_BRIDGE_KEY];
	if (!isBridge(value)) return null;
	return {
		bridgeVersion: value.bridgeVersion,
		toolExecutionMode: value.toolExecutionMode,
	};
}
