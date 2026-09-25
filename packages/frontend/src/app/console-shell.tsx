import type { IdentityInfo } from "@vcpdeck/shared";
import { ChevronLeft, ChevronsLeft, ChevronsRight, LogOut, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notification-bell";
import {
	isFullBleed,
	MODULES,
	resolveModule,
	visibleSubItems,
} from "./navigation";
import {
	applyTheme,
	readSidebarCollapsed,
	readTheme,
	saveSidebarCollapsed,
	type Theme,
} from "./theme";

/**
 * 应用外壳：左侧 Drill-down 侧栏 + 顶部工具条 + 主内容区。
 *
 * 导航层级完全由 URL 派生——当前路径命中带二级的模块时，侧栏**原位**切换为该模块的
 * 二级导航（一级与二级永不并排），并在左下角提供「返回全局导航」；一级状态下不渲染该按钮。
 */
export function ConsoleShell({
	identity,
	onLogout,
	children,
}: {
	identity: IdentityInfo;
	onLogout: () => void | Promise<void>;
	children: ReactNode;
}) {
	const location = useLocation();
	const navigate = useNavigate();
	// 收敛成三态，避免 hasSub 为 true 时 TS 仍把 module 视为 undefined
	const activeModule = resolveModule(location.pathname);
	const subItems = visibleSubItems(activeModule, identity.isAdmin === true);
	const subNav =
		activeModule && subItems.length > 0
			? { module: activeModule, items: subItems }
			: null;
	const hasSub = subNav !== null;
	const ModuleIcon = subNav?.module.icon;
	const fullBleed = isFullBleed(location.pathname);

	// Back 目标：最近一个「不渲染二级导航」的**目标**路径。
	// 记来源路径会让来源为模块页时指向模块路径，点击等于原地不动，用户被困。
	const lastGlobalRef = useRef<string | null>(null);
	const currentPath = `${location.pathname}${location.search}`;
	useEffect(() => {
		if (!hasSub) lastGlobalRef.current = currentPath;
	}, [hasSub, currentPath]);

	function handleBack() {
		navigate(lastGlobalRef.current ?? "/dashboard");
	}

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
						<img
							src="/vcpdeck-logo.svg"
							alt=""
							aria-hidden="true"
							className="size-7 shrink-0"
						/>
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
					{subNav ? (
						<>
							<div
								data-testid="sidebar-module-title"
								className="mt-6 flex min-h-11 items-center gap-3 px-3 font-semibold"
							>
								{ModuleIcon && <ModuleIcon className="size-4" />}
								<span className="vcpdeck-sidebar-label">
									{subNav.module.label}
								</span>
							</div>
							<nav aria-label="模块导航" className="space-y-1">
								{subNav.items.map(({ path, label, icon: Icon }) => (
									<NavLink
										key={path}
										to={path}
										className={({ isActive }) =>
											`vcpdeck-nav-link ${isActive ? "active" : ""}`
										}
									>
										<Icon className="size-4" />
										<span className="vcpdeck-sidebar-label">{label}</span>
									</NavLink>
								))}
							</nav>
						</>
					) : (
						<nav aria-label="主导航" className="mt-6 space-y-1">
							{MODULES.map(({ id, path, label, icon: Icon }) => (
								<NavLink
									key={path}
									to={path}
									className={({ isActive }) =>
										`vcpdeck-nav-link ${isActive || activeModule?.id === id ? "active" : ""}`
									}
								>
									<Icon className="size-4" />
									<span className="vcpdeck-sidebar-label">{label}</span>
								</NavLink>
							))}
						</nav>
					)}
					<div data-testid="sidebar-footer" className="mt-auto space-y-2">
						{/* 一级状态整个元素不渲染：不用 hidden 属性——CSS display:flex 会覆盖它 */}
						{hasSub && (
							<button
								type="button"
								data-testid="sidebar-back"
								onClick={handleBack}
								aria-label="返回全局导航"
								className="vcpdeck-nav-link w-full"
							>
								<ChevronLeft className="size-4" />
								<span className="vcpdeck-sidebar-label">返回全局导航</span>
							</button>
						)}
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
								<img
									src="/vcpdeck-logo.svg"
									alt=""
									aria-hidden="true"
									className="size-6 shrink-0"
								/>
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
						{subNav && (
							<button
								type="button"
								data-testid="mobile-nav-back"
								onClick={handleBack}
								aria-label="返回全局导航"
							>
								‹ 返回
							</button>
						)}
						{subNav
							? subNav.items.map(({ path, label }) => (
									<NavLink key={path} to={path}>
										{label}
									</NavLink>
								))
							: MODULES.map(({ path, label }) => (
									<NavLink key={path} to={path}>
										{label}
									</NavLink>
								))}
					</nav>
					<main
						className={
							fullBleed
								? "h-[calc(100dvh-7rem)] overflow-hidden lg:h-[calc(100dvh-4rem)]"
								: "h-[calc(100dvh-7rem)] overflow-y-auto p-4 sm:p-6 lg:h-[calc(100dvh-4rem)]"
						}
					>
						{children}
					</main>
				</section>
			</div>
		</div>
	);
}
