import { Navigate, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "@/auth-context";
import { PageHeading } from "@/components/page-heading";
import { IdentitiesPanel } from "@/pages/identities-panel";
import { ProfilePanel } from "@/pages/profile-panel";
import { TokensPanel } from "@/pages/tokens-panel";

export function SettingsPage() {
	const { identity } = useAuth();
	const location = useLocation();
	const section = location.pathname.split("/")[2] || "profile";
	if (section === "identities" && !identity?.isAdmin) return <Navigate to="/settings/profile" replace />;
	if (!["profile", "tokens", "identities"].includes(section)) return <Navigate to="/settings/profile" replace />;
	return <div className="space-y-6"><PageHeading title="设置" description="管理个人资料、访问 Token 与身份。" /><p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">普通身份拥有全部远程业务权限，请仅创建可信操作者身份。</p><nav aria-label="设置导航" className="flex gap-2 border-b border-border/70 pb-3"><NavLink className="vcpdeck-nav-link" to="/settings/profile">个人资料</NavLink><NavLink className="vcpdeck-nav-link" to="/settings/tokens">Token</NavLink>{identity?.isAdmin && <NavLink className="vcpdeck-nav-link" to="/settings/identities">身份管理</NavLink>}</nav>{section === "profile" && <ProfilePanel />}{section === "tokens" && <TokensPanel />}{section === "identities" && identity?.isAdmin && <IdentitiesPanel />}</div>;
}
