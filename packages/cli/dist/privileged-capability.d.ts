import type { ClientInfo } from "@vcpdeck/shared";
/**
 * 判断 Client 是否可被当作 root 等价节点对待：
 * `available && mode === "sudo-all" && nonInteractive`（ADR-0023 Q2）。
 */
export declare function isRootEquivalent(client: ClientInfo | null | undefined): boolean;
/**
 * 非交互特权展示（ADR-0023）：
 * sudo-all 且可用/非交互 → root 等价；unavailable → root 等价不可用；缺省/旧 Client → 未报告。
 */
export declare function formatPrivilegeSummary(client: ClientInfo | null | undefined): string;
/**
 * 执行前 root 等价风险提示：仅对可 root 等价的 Client 返回警告文本，否则 null。
 * Server 只记录控制面 / Job / Session 级审计，非完整主机审计（ADR-0023 §5）。
 */
export declare function rootEquivalentWarning(client: ClientInfo | null | undefined): string | null;
