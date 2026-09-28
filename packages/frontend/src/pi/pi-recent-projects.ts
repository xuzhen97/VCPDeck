import type { PiCwdRef } from "@vcpdeck/shared";

const LEGACY_RECENT_KEY = "vcpdeck:pi-recent-projects";
const PROJECTS_KEY = "vcpdeck:agent-chat-projects";
const MAX_PROJECTS = 30;

export interface AgentProject extends PiCwdRef {
	pinned: boolean;
}

function storageKey(clientId: string): string {
	return `${PROJECTS_KEY}:${encodeURIComponent(clientId)}`;
}

function isProject(value: unknown): value is AgentProject {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return typeof item.rootDir === "string"
		&& typeof item.relativePath === "string"
		&& (item.pinned === undefined || typeof item.pinned === "boolean");
}

function identity(project: PiCwdRef): string {
	return `${project.rootDir}\u0000${project.relativePath}`;
}

/** 项目索引读取结果：`corrupted` 表示当前机器的存档无法解析，已被恢复为空列表。 */
export interface AgentProjectsSnapshot {
	projects: AgentProject[];
	corrupted: boolean;
}

/**
 * 读取当前机器的 Agent 项目索引；首次使用时从 Pi 项目选择器历史迁移。
 *
 * 存档损坏时不抛异常：返回空列表并标记 `corrupted`，由调用方提示“可重新添加项目”。
 */
export function loadAgentProjectsSnapshot(clientId: string): AgentProjectsSnapshot {
	const storage = globalThis.localStorage;
	const key = storageKey(clientId);
	const saved = storage.getItem(key);
	if (saved !== null) {
		try {
			const parsed: unknown = JSON.parse(saved);
			if (!Array.isArray(parsed)) return { projects: [], corrupted: true };
			return {
				projects: parsed.filter(isProject).slice(0, MAX_PROJECTS).map((item) => ({
					rootDir: item.rootDir,
					relativePath: item.relativePath,
					pinned: item.pinned === true,
				})),
				corrupted: false,
			};
		} catch {
			return { projects: [], corrupted: true };
		}
	}

	const legacy = storage.getItem(LEGACY_RECENT_KEY);
	if (!legacy) return { projects: [], corrupted: false };
	let parsed: unknown;
	try { parsed = JSON.parse(legacy); } catch { return { projects: [], corrupted: false }; }
	if (!Array.isArray(parsed)) return { projects: [], corrupted: false };
	const seen = new Set<string>();
	const projects: AgentProject[] = [];
	for (const value of parsed) {
		if (!value || typeof value !== "object") continue;
		const item = value as Record<string, unknown>;
		if (item.clientId !== clientId || typeof item.rootDir !== "string" || typeof item.relativePath !== "string") continue;
		const project = { rootDir: item.rootDir, relativePath: item.relativePath, pinned: false };
		const id = identity(project);
		if (seen.has(id)) continue;
		seen.add(id);
		projects.push(project);
		if (projects.length >= MAX_PROJECTS) break;
	}
	return { projects, corrupted: false };
}

/** 读取当前机器的 Agent 项目索引；损坏时静默返回空列表。 */
export function loadAgentProjects(clientId: string): AgentProject[] {
	return loadAgentProjectsSnapshot(clientId).projects;
}

/** 将项目置于最近位置；已有置顶状态保留。 */
export function touchAgentProject(projects: AgentProject[], ref: PiCwdRef): AgentProject[] {
	const key = identity(ref);
	const existing = projects.find((project) => identity(project) === key);
	return [
		{ ...ref, pinned: existing?.pinned ?? false },
		...projects.filter((project) => identity(project) !== key),
	].slice(0, MAX_PROJECTS);
}

/** 切换本地置顶状态，不会触发任何远程操作。 */
export function toggleAgentProjectPin(projects: AgentProject[], ref: PiCwdRef): AgentProject[] {
	return projects.map((project) => identity(project) === identity(ref)
		? { ...project, pinned: !project.pinned }
		: project);
}

/** 从当前浏览器的 Agent 索引移除项目，不会删除目录或远程会话。 */
export function removeAgentProject(projects: AgentProject[], ref: PiCwdRef): AgentProject[] {
	return projects.filter((project) => identity(project) !== identity(ref));
}

/** 持久化单台机器的项目索引。 */
export function saveAgentProjects(clientId: string, projects: AgentProject[]): void {
	globalThis.localStorage.setItem(storageKey(clientId), JSON.stringify(projects.slice(0, MAX_PROJECTS)));
}

/** 按置顶优先、其余最近使用排序。 */
export function sortAgentProjects(projects: AgentProject[]): AgentProject[] {
	return [...projects].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}
