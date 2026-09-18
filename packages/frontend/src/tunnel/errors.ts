/**
 * 隧道 / 远程桌面错误码 → 已批准中文文案。
 * 只映射稳定 code，不回显 Server details、SDP、凭据或正文。
 */
export function friendlyTunnelError(code?: string): string {
	switch (code) {
		case "TUNNEL_CLIENT_UNAVAILABLE":
			return "目标机器当前离线";
		case "TUNNEL_CLIENT_UNSUPPORTED":
			return "该 Client 不支持 P2P 隧道协议 v1";
		case "TUNNEL_TARGET_REFUSED":
			return "目标端口拒绝连接（服务可能未监听）";
		case "TUNNEL_BACKPRESSURE_LIMIT":
			return "隧道数据回压超限，已关闭";
		case "TUNNEL_OPEN_TIMEOUT":
			return "连接建立超时（可能无法打洞或中继不可用）";
		case "TUNNEL_SESSION_EXPIRED":
			return "会话已过期，请重试";
		default:
			return "隧道操作失败，请重试";
	}
}

/**
 * VNC 认证 / 断开场景的补充文案（依赖 browser-tunnel 暴露的 failureCode）。
 * 优先识别 5900 无监听，其余走通用隧道文案。
 */
export function friendlyDesktopError(code?: string | null): string {
	if (!code) return friendlyTunnelError();
	if (code === "VNC_AUTH_FAILED") return "VNC 认证失败";
	if (code === "VNC_DISCONNECTED") return "远程桌面已断开";
	return friendlyTunnelError(code);
}
