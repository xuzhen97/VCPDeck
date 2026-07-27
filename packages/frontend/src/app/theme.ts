export type Theme = "dark" | "light";

const THEME_KEY = "vcpdeck.theme";
const SIDEBAR_KEY = "vcpdeck.sidebarCollapsed";

export function readTheme(): Theme {
	return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
	document.documentElement.classList.toggle("dark", theme === "dark");
	localStorage.setItem(THEME_KEY, theme);
}

export function readSidebarCollapsed(): boolean {
	return localStorage.getItem(SIDEBAR_KEY) === "true";
}

export function saveSidebarCollapsed(collapsed: boolean): void {
	localStorage.setItem(SIDEBAR_KEY, String(collapsed));
}
