import type { ClientInfo } from "@vcpdeck/shared";

/**
 * 从 Client 能力摘要读取非交互特权能力（旧 Client 缺省为 undefined）。
 */
function readPrivileged(client: ClientInfo | null | undefined) {
	return client?.capabilityDetails?.privileged;
}

/**
 * 判断 Client 是否可被当作 root 等价节点对待：
 * `available && nonInteractive` 且模式为 sudo-all 或 direct-root（ADR-0023 Q2 / ADR-0065）。
 */
export function isRootEquivalent(client: ClientInfo | null | undefined): boolean {
	const p = readPrivileged(client);
	if (!p || !p.available || !p.nonInteractive) return false;
	return p.mode === "sudo-all" || p.mode === "direct-root";
}

/**
 * 非交互特权展示（ADR-0023 / ADR-0065）：
 * sudo-all 且可用/非交互 → root 等价；direct-root → procd 直接 root（非沙箱）；
 * unavailable → root 等价不可用；缺省/旧 Client → 未报告。
 */
export function formatPrivilegeSummary(client: ClientInfo | null | undefined): string {
	const p = readPrivileged(client);
	if (!p) return "未报告";
	if (p.mode === "direct-root") {
		return p.available ? "procd · 直接 root（整机权限，非沙箱）" : "直接 root 特权不可用";
	}
	if (isRootEquivalent(client)) return "root 等价";
	return "root 等价不可用";
}

/**
 * 执行前 root 等价风险提示：仅对可 root 等价的 Client 返回警告文本，否则 null。
 * Server 只记录控制面 / Job / Session 级审计，非完整主机审计（ADR-0023 §5）。
 */
export function rootEquivalentWarning(client: ClientInfo | null | undefined): string | null {
	if (!isRootEquivalent(client)) return null;
	return (
		"警告: 该机器具备 root 等价特权，可执行任意 root 命令。" +
		"Server 只记录控制面 / Job / Session 审计，请确认在可信运维域内。"
	);
}
