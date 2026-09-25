/**
 * 旧 `/pi/*` 入口到 Agent 模块二级项的目标路径。
 *
 * 逐段映射 `profile` / `provider` / `runtime`，历史别名 `credentials` 归到 Provider；
 * 模块根与任何未知段一律落到对话视图，不猜测语义。
 */
export function legacyPiTarget(pathname: string): string {
	// 只取 /pi/ 之后的第一段；不匹配（模块根、无尾段）时落到对话
	const section = /^\/pi\/([^/]+)/.exec(pathname)?.[1] ?? "";
	if (section === "profile") return "/agent/profile";
	if (section === "provider" || section === "credentials")
		return "/agent/provider";
	if (section === "runtime") return "/agent/runtime";
	return "/agent/chat";
}

/**
 * 机器详情旧 Pi 入口的目标路径：保留机器上下文并落到全局 Agent 对话页。
 * 缺少 clientId 时不带查询参数。
 */
export function machinePiTarget(clientId: string): string {
	return clientId
		? `/agent/chat?client=${encodeURIComponent(clientId)}`
		: "/agent/chat";
}
