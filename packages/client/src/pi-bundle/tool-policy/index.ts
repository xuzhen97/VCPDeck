/**
 * VCPDeck 执行模式扩展（Bundle 资源 `vcp.tool-policy` v3）。
 *
 * 这是随 Client Release 发布、由 Release 构建打包成**自包含单文件**的 Pi 扩展：
 * 不 import 任何运行时模块（只允许类型导入，构建后擦除），所有逻辑在本文件内实现。
 *
 * 语义（ADR-0039 决策 1 + ADR-0040 决策 5）：
 * - `automatic` → 直接放行。能力面由当前 Runtime 实际注册/加载的工具决定；
 * - `supervised` → **每次**模型工具调用都调用 `ctx.ui.confirm()` 请求人工批准，
 *   包含读取工具；拒绝、取消或超时一律阻塞（`PI_TOOL_POLICY_REJECTED`）；
 * - 桥接缺失、`bridgeVersion` 不符或模式缺失/非法 → **阻塞所有工具调用**
 *   （`PI_POLICY_UNAVAILABLE`），宁可不可用也不 fail open，也不猜默认模式。
 *
 * 逐工具三桶（`allow` / `confirm` / `deny`）已删除：本扩展不再读取任何工具名单，
 * 因此「新增扩展工具需要额外配置」这一负担随之消失。
 *
 * 模式经进程内 host bridge（`globalThis.__vcpdeckPiHost`，bridge v3）传入：
 * 不落盘、不进环境变量（`bash` 工具派生的子进程会继承环境变量）。
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/** 桥接契约版本；与 Client 的 `tool-policy-bridge.ts` 必须一致。 */
const BRIDGE_VERSION = 3;
const BRIDGE_KEY = "__vcpdeckPiHost";

const REASON_REJECTED = "PI_TOOL_POLICY_REJECTED";
const REASON_UNAVAILABLE = "PI_POLICY_UNAVAILABLE";

type ExecutionMode = "supervised" | "automatic";

interface HostBridge {
	bridgeVersion?: unknown;
	toolExecutionMode?: unknown;
}

function isExecutionMode(value: unknown): value is ExecutionMode {
	return value === "supervised" || value === "automatic";
}

/** 读取并校验桥接；缺失、版本不符或模式非法都返回 null（调用方据此 fail closed）。 */
function readMode(): ExecutionMode | null {
	const host = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as
		| HostBridge
		| undefined;
	if (!host || host.bridgeVersion !== BRIDGE_VERSION) return null;
	if (!isExecutionMode(host.toolExecutionMode)) return null;
	return host.toolExecutionMode;
}

function blocked(reason: string, toolName: string): ToolCallEventResult {
	return { block: true, reason: `${reason}: ${toolName}` };
}

/** 扩展入口：default 导出（jiti 加载器按 default 取工厂）。 */
export default function toolPolicyExtension(pi: ExtensionAPI): void {
	// 模式在 Worker 生命周期内不可变（ADR-0039 决策 2），因此只在 factory 阶段读一次。
	const mode = readMode();

	pi.on(
		"tool_call",
		async (
			event: ToolCallEvent,
			ctx: ExtensionContext,
		): Promise<ToolCallEventResult | undefined> => {
			const toolName = event.toolName;
			if (!mode) return blocked(REASON_UNAVAILABLE, toolName);
			if (mode === "automatic") return undefined;
			// supervised：每次调用都必须取得明确批准。
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
