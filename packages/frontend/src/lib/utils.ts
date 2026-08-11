import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** 将原始 capability 列表映射为可读的中文标签，未映射的保留原文 */
export function capabilitiesLabel(raw: string[]): string[] {
	const labels: string[] = [];
	const seen = new Set<string>();
	if (raw.includes("exec")) {
		labels.push("命令执行");
		seen.add("exec");
	}
	if (raw.includes("file.read") || raw.includes("file.write")) {
		labels.push("文件操作");
		seen.add("file.read");
		seen.add("file.write");
	}
	if (raw.includes("frp")) {
		labels.push("映射");
		seen.add("frp");
	}
	if (raw.includes("agent.pi")) {
		labels.push("Pi 运行");
		seen.add("agent.pi");
	}
	// 未映射的原始能力透传，确保显示不遗漏
	for (const cap of raw) {
		if (!seen.has(cap)) labels.push(cap);
	}
	return labels;
}
