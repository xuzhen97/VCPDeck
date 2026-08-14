import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
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
