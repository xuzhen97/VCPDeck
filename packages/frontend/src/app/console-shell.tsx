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
	{ to: "/frp", label: "映射", icon: Cable },
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
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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
				{mobileSidebarOpen && (
					<button
						type="button"
						aria-label="关闭侧栏遮罩"
						className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm lg:hidden"
						onClick={() => setMobileSidebarOpen(false)}
					/>
				)}
				<aside
					className={`vcpdeck-sidebar ${collapsed ? "vcpdeck-sidebar-collapsed" : ""} ${mobileSidebarOpen ? "vcpdeck-sidebar-mobile-open" : ""}`}
				>
					<div
						data-testid="sidebar-brand"
						className="flex min-h-12 items-center gap-3 px-2"
					>
						<Boxes className="size-6 shrink-0 text-primary" />
						<span className="vcpdeck-sidebar-label min-w-0 flex-1 font-semibold">
							VCPDeck
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-10 min-h-10 shrink-0 rounded-lg lg:hidden"
							onClick={() => setMobileSidebarOpen(false)}
							aria-label="关闭侧栏"
						>
							<ChevronsLeft className="size-4" />
						</Button>
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
					<div data-testid="sidebar-footer" className="mt-auto space-y-2">
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
					<header className="relative z-40 flex h-16 items-center justify-between border-b border-border/70 bg-card/30 px-4 backdrop-blur-xl sm:px-6">
						<div className="flex items-center gap-2">
							<div className="flex items-center gap-2 lg:hidden">
								<span className="font-semibold">VCPDeck</span>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="size-10 min-h-10 rounded-lg lg:hidden"
									onClick={() => setMobileSidebarOpen(true)}
									aria-label="打开侧栏"
								>
									<ChevronsRight className="size-4" />
								</Button>
							</div>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="vcpdeck-sidebar-toggle hidden size-10 min-h-10 rounded-lg lg:inline-flex"
								onClick={toggleSidebar}
								aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
							>
								{collapsed ? (
									<ChevronsRight className="size-4" />
								) : (
									<ChevronsLeft className="size-4" />
								)}
							</Button>
						</div>
						<div className="ml-auto flex items-center gap-2">
							<NotificationBell />
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="size-10 min-h-10 rounded-lg"
								onClick={toggleTheme}
								aria-label="切换主题"
							>
								{theme === "dark" ? (
									<Sun className="size-4" />
								) : (
									<Moon className="size-4" />
								)}
							</Button>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="size-10 min-h-10 rounded-lg"
								onClick={onLogout}
								aria-label="退出登录"
							>
								<LogOut className="size-4" />
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
