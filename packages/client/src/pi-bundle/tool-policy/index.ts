/**
 * VCPDeck 工具策略扩展（Bundle 资源 `vcp.tool-policy`）。
 *
 * 这是随 Client Release 发布、由 Release 构建打包成**自包含单文件**的 Pi 扩展：
 * 不 import 任何运行时模块（只允许类型导入，构建后擦除），所有路径都在本文件内实现。
 *
 * 语义（docs/adr/0030 决策 2）：
 * - `deny` → 阻塞（`PI_TOOL_POLICY_DENIED`）；
 * - `confirm` → 每次调用都经既有 Extension UI 审批链路询问操作者；拒绝/取消/超时 → 阻塞
 *   （`PI_TOOL_POLICY_REJECTED`）；
 * - `allow` → 放行；
 * - 未出现在任何桶 → 阻塞（默认拒绝）；
 * - 策略来自进程内 host bridge（`globalThis.__vcpdeckPiHost`）；桥接缺失或版本不符时
 *   **阻塞所有工具调用**（`PI_POLICY_UNAVAILABLE`），宁可不可用也不 fail open。
 *
 * 策略不落盘、不进环境变量：`bash` 工具派生的子进程会继承环境变量。
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/** 桥接契约版本；与 Client 的 `tool-policy-bridge.ts` 必须一致。 */
const BRIDGE_VERSION = 1;
const BRIDGE_KEY = "__vcpdeckPiHost";

const REASON_DENIED = "PI_TOOL_POLICY_DENIED";
const REASON_REJECTED = "PI_TOOL_POLICY_REJECTED";
const REASON_UNAVAILABLE = "PI_POLICY_UNAVAILABLE";

interface HostBridge {
	bridgeVersion?: unknown;
	toolPolicy?: { allow?: unknown; confirm?: unknown; deny?: unknown };
}

interface ResolvedPolicy {
	allow: string[];
	confirm: string[];
	deny: string[];
}

function toStringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/** 读取并校验桥接；缺失、版本不符或形状非法都返回 null。 */
function readPolicy(): ResolvedPolicy | null {
	const host = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as
		| HostBridge
		| undefined;
	if (!host || host.bridgeVersion !== BRIDGE_VERSION) return null;
	const policy = host.toolPolicy;
	if (typeof policy !== "object" || policy === null) return null;
	if (
		!Array.isArray(policy.allow) ||
		!Array.isArray(policy.confirm) ||
		!Array.isArray(policy.deny)
	) {
		return null;
	}
	return {
		allow: toStringList(policy.allow),
		confirm: toStringList(policy.confirm),
		deny: toStringList(policy.deny),
	};
}

function blocked(reason: string, toolName: string): ToolCallEventResult {
	return { block: true, reason: `${reason}: ${toolName}` };
}

/** 扩展入口：default 导出（jiti 加载器按 default 取工厂）。 */
export default function toolPolicyExtension(pi: ExtensionAPI): void {
	// 策略在 Worker 生命周期内不可变（ADR-0029 决策 5），因此只在 factory 阶段读一次。
	const policy = readPolicy();

	pi.on(
		"tool_call",
		async (
			event: ToolCallEvent,
			ctx: ExtensionContext,
		): Promise<ToolCallEventResult | undefined> => {
			const toolName = event.toolName;
			if (!policy) return blocked(REASON_UNAVAILABLE, toolName);
			if (policy.deny.includes(toolName)) {
				return blocked(REASON_DENIED, toolName);
			}
			if (!policy.confirm.includes(toolName)) {
				// 白名单语义：只有 allow 桶里的工具才自动放行
				return policy.allow.includes(toolName)
					? undefined
					: blocked(REASON_DENIED, toolName);
			}
			const approved = await ctx.ui.confirm(
				`允许 Pi 调用工具 ${toolName}？`,
				"该调用会在目标机器上执行。拒绝、取消或超时都会被判定为拒绝。",
			);
			return approved === true
				? undefined
				: blocked(REASON_REJECTED, toolName);
		},
	);
}
