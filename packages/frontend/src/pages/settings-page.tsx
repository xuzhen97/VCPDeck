import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/auth-context";
import { PageHeading } from "@/components/page-heading";
import { IdentitiesPanel } from "@/pages/identities-panel";
import { ProfilePanel } from "@/pages/profile-panel";
import { StoragePanel } from "@/pages/storage-panel";
import { TokensPanel } from "@/pages/tokens-panel";
import { TunnelSettingsPanel } from "@/pages/tunnel-settings-panel";

/**
 * 设置模块：二级导航（个人资料 / Token / 网络 / 存储 / 身份管理）由 `ConsoleShell`
 * 按 URL 渲染，本组件只负责 section 校验与面板挂载。
 */
export function SettingsPage() {
	const { identity } = useAuth();
	const location = useLocation();
	// 只取 /settings/ 之后的第一段；无段时落到个人资料
	const section = /^\/settings\/([^/]+)/.exec(location.pathname)?.[1] ?? "profile";
	if (section === "identities" && !identity?.isAdmin)
		return <Navigate to="/settings/profile" replace />;
	// 兼容旧入口：Pi 设置已并入 Agent 模块
	if (section === "pi") return <Navigate to="/agent/profile" replace />;
	if (!["profile", "tokens", "network", "storage", "identities"].includes(section))
		return <Navigate to="/settings/profile" replace />;
	return (
		<div className="space-y-6">
			<PageHeading
				title="设置"
				description="管理个人资料、访问 Token、网络与存储。"
			/>
			<p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
				普通身份拥有全部远程业务权限，请仅创建可信操作者身份。
			</p>
			{section === "profile" && <ProfilePanel />}
			{section === "tokens" && <TokensPanel />}
			{section === "network" && <TunnelSettingsPanel />}
			{section === "storage" && <StoragePanel />}
			{section === "identities" && identity?.isAdmin && <IdentitiesPanel />}
		</div>
	);
}
