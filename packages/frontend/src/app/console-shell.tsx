import type { IdentityInfo } from "@vcpdeck/shared";
import {
	Boxes,
	Cable,
	ChevronsLeft,
	ChevronsRight,
	Database,
	LayoutDashboard,
	ListTodo,
	LogOut,
	MonitorCog,
	Moon,
	Settings,
	Sun,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notification-bell";
import {
	applyTheme,
	readSidebarCollapsed,
	readTheme,
	saveSidebarCollapsed,
	type Theme,
} from "./theme";

const navigation = [
	{ to: "/dashboard", label: "概览", icon: LayoutDashboard },
	{ to: "/machines", label: "机器", icon: MonitorCog },
	{ to: "/jobs", label: "任务", icon: ListTodo },
	{ to: "/frp", label: "FRP", icon: Cable },
	{ to: "/storage", label: "存储", icon: Database },
	{ to: "/settings/profile", label: "设置", icon: Settings },
];

export function ConsoleShell({
	identity,
	onLogout,
	children,
}: {
	identity: IdentityInfo;
	onLogout: () => void | Promise<void>;
	children: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
	const [theme, setTheme] = useState<Theme>(readTheme);

	function toggleTheme() {
		const next = theme === "dark" ? "light" : "dark";
		setTheme(next);
		applyTheme(next);
	}

	function toggleSidebar() {
		setCollapsed((current) => {
			saveSidebarCollapsed(!current);
			return !current;
		});
	}

	return (
		<div className="vcpdeck-background">
			<div
				className={`vcpdeck-shell ${collapsed ? "vcpdeck-shell-collapsed" : ""}`}
			>
				<aside
					className={`vcpdeck-sidebar ${collapsed ? "vcpdeck-sidebar-collapsed" : ""}`}
				>
					<div className="flex min-h-12 items-center gap-3 px-2">
						<Boxes className="size-6 text-primary" />
						<span className="vcpdeck-sidebar-label font-semibold">VCPDeck</span>
					</div>
					<nav aria-label="主导航" className="mt-6 space-y-1">
						{navigation.map(({ to, label, icon: Icon }) => (
							<NavLink
								key={to}
								to={to}
								className={({ isActive }) =>
									`vcpdeck-nav-link ${isActive ? "active" : ""}`
								}
							>
								<Icon className="size-4" />
								<span className="vcpdeck-sidebar-label">{label}</span>
							</NavLink>
						))}
					</nav>
					<div className="mt-auto space-y-2">
						<Button
							type="button"
							variant="ghost"
							className="w-full justify-start"
							onClick={toggleSidebar}
							aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
						>
							{collapsed ? <ChevronsRight /> : <ChevronsLeft />}
							<span className="vcpdeck-sidebar-label">收起侧栏</span>
						</Button>
						<div className="border-t border-border/70 pt-3 text-sm">
							<p className="vcpdeck-sidebar-label truncate font-medium">
								{identity.displayName}
							</p>
							<p className="vcpdeck-sidebar-label truncate text-xs text-muted-foreground">
								@{identity.username}
							</p>
						</div>
					</div>
				</aside>
				<section className="vcpdeck-main-column">
					<header className="flex h-16 items-center justify-between border-b border-border/70 bg-card/30 px-4 backdrop-blur-xl sm:px-6">
						<span className="font-semibold lg:hidden">VCPDeck</span>
						<div className="ml-auto flex items-center gap-2">
							<NotificationBell />
							<Button
								type="button"
								size="icon"
								variant="ghost"
								onClick={toggleTheme}
								aria-label="切换主题"
							>
								{theme === "dark" ? <Sun /> : <Moon />}
							</Button>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								onClick={onLogout}
								aria-label="退出登录"
							>
								<LogOut />
							</Button>
						</div>
					</header>
					<nav aria-label="移动导航" className="vcpdeck-mobile-nav lg:hidden">
						{navigation.map(({ to, label }) => (
							<NavLink key={to} to={to}>
								{label}
							</NavLink>
						))}
					</nav>
					<main className="h-[calc(100dvh-7rem)] overflow-y-auto p-4 sm:p-6 lg:h-[calc(100dvh-4rem)]">
						{children}
					</main>
				</section>
			</div>
		</div>
	);
}
