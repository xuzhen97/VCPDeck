/**
 * VCPDeck 工具策略扩展（Bundle 资源 `vcp.tool-policy`）。
 *
 * 这是随 Client Release 发布、由 Release 构建打包成**自包含单文件**的 Pi 扩展：
 * 不 import 任何运行时模块（只允许类型导入，构建后擦除），所有路径都在本文件内实现。
 *
 * 语义（docs/adr/0030 决策 2 + docs/adr/0033 执行模式）：
 * - `yolo` → 跳过三桶判定，直接放行（能力上限由当前 Runtime 实际注册/加载的工具集合决定）；
 * - `deny` → 阻塞（`PI_TOOL_POLICY_DENIED`）；
 * - `confirm` + `auto` → 放行（无人工审批）；
 * - `confirm` + `approval` → 每次调用都经既有 Extension UI 审批链路询问操作者；拒绝/取消/超时
 *   → 阻塞（`PI_TOOL_POLICY_REJECTED`）；
 * - `allow` → 放行；
 * - 未出现在任何桶 → 阻塞（默认拒绝）；
 * - 策略与模式来自进程内 host bridge（`globalThis.__vcpdeckPiHost`，bridge v2）；桥接缺失、
 *   版本不符、模式缺失/非法或策略形状非法时**阻塞所有工具调用**（`PI_POLICY_UNAVAILABLE`），
 *   宁可不可用也不 fail open，也不猜默认模式。
 *
 * 策略与模式不落盘、不进环境变量：`bash` 工具派生的子进程会继承环境变量。
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/** 桥接契约版本；与 Client 的 `tool-policy-bridge.ts` 必须一致。 */
const BRIDGE_VERSION = 2;
const BRIDGE_KEY = "__vcpdeckPiHost";

const REASON_DENIED = "PI_TOOL_POLICY_DENIED";
const REASON_REJECTED = "PI_TOOL_POLICY_REJECTED";
const REASON_UNAVAILABLE = "PI_POLICY_UNAVAILABLE";

type ExecutionMode = "approval" | "auto" | "yolo";

/** 单一决策点：放行 / 需人工审批 / 阻塞。 */
type ToolDecision = "allow" | "approve" | "deny";

interface HostBridge {
	bridgeVersion?: unknown;
	toolPolicy?: { allow?: unknown; confirm?: unknown; deny?: unknown };
	toolExecutionMode?: unknown;
}

interface ResolvedSnapshot {
	mode: ExecutionMode;
	allow: string[];
	confirm: string[];
	deny: string[];
}

function toStringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return null;
		out.push(item);
	}
	return out;
}

function isExecutionMode(value: unknown): value is ExecutionMode {
	return value === "approval" || value === "auto" || value === "yolo";
}

/** 读取并校验桥接；缺失、版本不符、模式或策略形状非法都返回 null。 */
function readSnapshot(): ResolvedSnapshot | null {
	const host = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as
		| HostBridge
		| undefined;
	if (!host || host.bridgeVersion !== BRIDGE_VERSION) return null;
	if (!isExecutionMode(host.toolExecutionMode)) return null;
	const policy = host.toolPolicy;
	if (typeof policy !== "object" || policy === null) return null;
	const allow = toStringList(policy.allow);
	const confirm = toStringList(policy.confirm);
	const deny = toStringList(policy.deny);
	if (!allow || !confirm || !deny) return null;
	return { mode: host.toolExecutionMode, allow, confirm, deny };
}

/**
 * 决策函数（ADR-0033 决策 2 的等价实现）：
 * YOLO 不参与三桶判定；其余先看 deny（fail closed），再看 allow，最后只看 confirm。
 */
function resolveToolDecision(
	snapshot: ResolvedSnapshot,
	toolName: string,
): ToolDecision {
	if (snapshot.mode === "yolo") return "allow";
	if (snapshot.deny.includes(toolName)) return "deny";
	if (snapshot.allow.includes(toolName)) return "allow";
	if (!snapshot.confirm.includes(toolName)) return "deny";
	return snapshot.mode === "auto" ? "allow" : "approve";
}

function blocked(reason: string, toolName: string): ToolCallEventResult {
	return { block: true, reason: `${reason}: ${toolName}` };
}

/** 扩展入口：default 导出（jiti 加载器按 default 取工厂）。 */
export default function toolPolicyExtension(pi: ExtensionAPI): void {
	// 策略与模式在 Worker 生命周期内不可变（ADR-0029 决策 5），因此只在 factory 阶段读一次。
	const snapshot = readSnapshot();

	pi.on(
		"tool_call",
		async (
			event: ToolCallEvent,
			ctx: ExtensionContext,
		): Promise<ToolCallEventResult | undefined> => {
			const toolName = event.toolName;
			if (!snapshot) return blocked(REASON_UNAVAILABLE, toolName);
			const decision = resolveToolDecision(snapshot, toolName);
			if (decision === "deny") return blocked(REASON_DENIED, toolName);
			if (decision === "allow") return undefined;
			// 仅 `confirm + approval` 会走到这里：YOLO 与 Auto 不得产生任何审批。
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
