import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * 生成 UUID v4。
 *
 * `crypto.randomUUID` 只在安全上下文（HTTPS / localhost）可用；VCPDeck 以明文 HTTP
 * 部署时它是 `undefined`，直接调用会抛错。此处退回 `getRandomValues`（非安全上下文
 * 同样可用）按 v4 规则拼装。
 */
export function randomUUID(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 机器详情 tab 定义：路由 key + 中文标签（机器列表卡片快速跳转与详情页导航共用） */
export const MACHINE_TABS = [
	["overview", "概览"],
	["execute", "执行"],
	["files", "文件"],
	["frp", "映射"],
	["jobs", "任务记录"],
	["pi", "Pi"],
	["terminal", "终端"],
	["tunnel", "隧道"],
	["desktop", "远程桌面"],
] as const;

/** 能力 → 中文标签；未映射的能力原样透传，确保显示不遗漏 */
const CAPABILITY_LABELS: Record<string, string> = {
	exec: "命令执行",
	"file.read": "文件操作",
	"file.write": "文件操作",
	frp: "映射",
	"agent.pi": "Pi 运行",
	"terminal.pty": "终端",
};

export function capabilitiesLabel(raw: string[]): string[] {
	const labels: string[] = [];
	const seen = new Set<string>();
	for (const cap of raw) {
		const label = CAPABILITY_LABELS[cap] ?? cap;
		if (seen.has(label)) continue;
		seen.add(label);
		labels.push(label);
	}
	return labels;
}

/** 不合规原因 → 已批准中文文案（ADR-0027）；未映射原因原样透传，确保不遗漏。 */
const UPGRADE_REASON_LABELS: Record<string, string> = {
	"legacy-pm2": "旧版 PM2",
	"installation-unreported": "安装模式未报告",
	"privilege-noncompliant": "特权状态异常",
	"platform-mode-mismatch": "安装状态异常",
	"platform-unsupported": "不支持的平台",
};

export function upgradeReasonLabel(reason: string): string {
	return UPGRADE_REASON_LABELS[reason] ?? reason;
}
