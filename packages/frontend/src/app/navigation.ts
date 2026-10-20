import {
	Blocks,
	Cable,
	Code2,
	Database,
	KeyRound,
	LayoutDashboard,
	ListTodo,
	Lock,
	MonitorCog,
	Rocket,
	Settings,
	UserRound,
	Users,
	type LucideIcon,
} from "lucide-react";

/** 侧栏导航项：模块二级导航条目。 */
export interface NavItem {
	/** 绝对路径，同时用于 NavLink 与激活判定 */
	path: string;
	label: string;
	icon: LucideIcon;
	/** 仅 admin 可见（身份管理） */
	adminOnly?: boolean;
	/** 该视图需要满高、无内边距的主内容区（对话三栏布局） */
	fullBleed?: boolean;
}

/** 一级模块。存在 sub 时该模块使用侧栏二级导航。 */
export interface NavModule {
	/** 稳定标识，用于一级导航激活判定 */
	id: string;
	/** 模块根前缀，例如 "/settings" */
	path: string;
	label: string;
	icon: LucideIcon;
	/** 二级导航条目；缺省表示单页模块，始终显示一级导航 */
	sub?: NavItem[];
}

/**
 * 一级导航与各模块二级导航的唯一事实来源。
 *
 * 层级完全由 URL 派生：`ConsoleShell` 按当前路径前缀匹配模块，有二级项就渲染二级导航，
 * 否则渲染一级导航——一级与二级永不并排展示。
 */
export const MODULES: NavModule[] = [
	{ id: "dashboard", path: "/dashboard", label: "概览", icon: LayoutDashboard },
	{ id: "machines", path: "/machines", label: "机器", icon: MonitorCog },
	{ id: "jobs", path: "/jobs", label: "任务", icon: ListTodo },
	{ id: "frp", path: "/frp", label: "映射", icon: Cable },
	{ id: "features", path: "/features", label: "功能", icon: Blocks },
	// 「开发」= 人机协作：跨机器远程 DSH，一屏启动并直接进入完整 WebUI。
	{ id: "develop", path: "/develop", label: "开发", icon: Code2 },
	{ id: "releases", path: "/releases", label: "发版", icon: Rocket },
	{
		id: "settings",
		path: "/settings",
		label: "设置",
		icon: Settings,
		sub: [
			{ path: "/settings/profile", label: "个人资料", icon: UserRound },
			{ path: "/settings/tokens", label: "Token", icon: KeyRound },
			{ path: "/settings/git-ssh", label: "Git 密钥", icon: Lock },
			{ path: "/settings/storage", label: "存储", icon: Database },
			{
				path: "/settings/identities",
				label: "身份管理",
				icon: Users,
				adminOnly: true,
			},
		],
	},
];

/**
 * 按段边界前缀匹配模块。
 *
 * 未匹配时返回 `undefined` 而不是猜测：`/machines/client-1/files` 属于 `machines`
 * （该模块无二级，仍显示一级导航）；退役的 `/agent/*` 不再属于任何模块。
 */
export function resolveModule(pathname: string): NavModule | undefined {
	return MODULES.find(
		(mod) => pathname === mod.path || pathname.startsWith(`${mod.path}/`),
	);
}

/** 当前路径是否命中声明了 `fullBleed` 的视图（最深前缀匹配）。 */
export function isFullBleed(pathname: string): boolean {
	let best: string | undefined;
	for (const mod of MODULES) {
		for (const item of mod.sub ?? []) {
			if (!item.fullBleed) continue;
			if (pathname !== item.path && !pathname.startsWith(`${item.path}/`))
				continue;
			if (!best || item.path.length > best.length) best = item.path;
		}
	}
	return best !== undefined;
}

/** 按身份过滤后的模块二级项；无二级的模块返回空数组。 */
export function visibleSubItems(
	mod: NavModule | undefined,
	isAdmin: boolean,
): NavItem[] {
	return (mod?.sub ?? []).filter((item) => !item.adminOnly || isAdmin);
}
