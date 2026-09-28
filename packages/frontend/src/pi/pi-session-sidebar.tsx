import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, MessageSquarePlus, Plus, Star, X } from "lucide-react";
import type { PiCwdRef, PiSessionInfo, PiSessionTreeNode } from "@vcpdeck/shared";
import type { PiApi } from "@vcpdeck/sdk";
import { PiProjectPicker, type PiFilesApiLike } from "./pi-project-picker.js";
import { PiImportDialog } from "./pi-import-dialog.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmTargetDialog } from "@/components/confirm-target-dialog";
import { cn } from "@/lib/utils";
import { loadAgentProjectsSnapshot, removeAgentProject, saveAgentProjects, sortAgentProjects, toggleAgentProjectPin, touchAgentProject, type AgentProject } from "./pi-recent-projects.js";

interface SidebarSession extends PiSessionInfo {
	tree: PiSessionTreeNode[];
}

/** 今日 / 最近 7 天 / 更早：按 modified 日期分桶，每桶内按 modified 倒序 */
function groupByDate(sessions: SidebarSession[]) {
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
	const buckets: Array<{
		key: "today" | "week" | "earlier";
		label: string;
		items: SidebarSession[];
	}> = [
		{ key: "today", label: "今天", items: [] },
		{ key: "week", label: "最近 7 天", items: [] },
		{ key: "earlier", label: "更早", items: [] },
	];
	for (const s of sessions) {
		const d = new Date(s.modified);
		if (d >= todayStart) buckets[0]!.items.push(s);
		else if (d >= weekStart) buckets[1]!.items.push(s);
		else buckets[2]!.items.push(s);
	}
	for (const b of buckets) {
		b.items.sort(
			(a, c) => new Date(c.modified).getTime() - new Date(a.modified).getTime(),
		);
	}
	return buckets.filter((b) => b.items.length > 0);
}

/** "刚刚 / Nm ago / Nh ago / Nd ago / 日期" */
function relativeTime(modified: string): string {
	const diffMs = Date.now() - new Date(modified).getTime();
	const min = Math.floor(diffMs / 60_000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const d = Math.floor(hr / 24);
	if (d < 30) return `${d}d ago`;
	return new Date(modified).toLocaleDateString();
}

type ListedSession = SidebarSession;

function projectKey(ref: PiCwdRef): string { return `${ref.rootDir}\u0000${ref.relativePath}`; }
function sameProject(a: PiCwdRef, b: PiCwdRef): boolean { return projectKey(a) === projectKey(b); }
/** 传入协议层的永远是纯 cwd 引用：`pinned` 只是浏览器 UI 状态，不得混进跨端请求。 */
function cwdRefOf(project: PiCwdRef): PiCwdRef { return { rootDir: project.rootDir, relativePath: project.relativePath }; }

/** 侧栏图标按钮：只显示图标，但保留可访问名称、悬停提示与键盘焦点态。 */
function SidebarIconButton({
	label,
	onClick,
	children,
	className,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
	className?: string;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className={cn(
				"flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-secondary hover:text-foreground",
				className,
			)}
		>
			{children}
		</button>
	);
}

/**
 * Agent 聊天专用多项目索引。项目列表只存在浏览器，Session 内容仍由 Client 提供。
 *
 * 视觉上是一块平整导航（不套卡片）：项目为一级行，会话缩进在日期分组下，
 * 二级操作收成悬停/聚焦时浮现的图标按钮，避免每行堆一排文字按钮。
 */
export function AgentProjectNavigator({
	clientId,
	files,
	pi,
	selectedCwd,
	activeSessionId,
	mutableSessionIds,
	onSelectProject,
	onSelectSession,
	onCreated,
}: {
	clientId: string;
	files: PiFilesApiLike;
	pi: Pick<PiApi, "sessions" | "agent">;
	selectedCwd: PiCwdRef | null;
	activeSessionId: string | null;
	mutableSessionIds: ReadonlySet<string>;
	onSelectProject: (ref: PiCwdRef | null) => void;
	onSelectSession: (sessionId: string | null, ref: PiCwdRef) => void;
	onCreated: (sessionId: string, ref: PiCwdRef) => void;
}) {
	const { projects: persistedProjects, corrupted } = useMemo(
		() => loadAgentProjectsSnapshot(clientId),
		[clientId],
	);
	const loadError = corrupted ? "浏览器本地项目列表损坏，已使用空列表；可重新添加项目。" : null;
	const [projects, setProjects] = useState<AgentProject[]>(persistedProjects);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [loaded, setLoaded] = useState<Record<string, boolean>>({});
	const [loading, setLoading] = useState<Record<string, boolean>>({});
	const [errors, setErrors] = useState<Record<string, string | null>>({});
	const [sessionLists, setSessionLists] = useState<Record<string, ListedSession[]>>({});
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<{ session: ListedSession; project: AgentProject } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const projectsRef = useRef(projects);
	projectsRef.current = projects;

	useEffect(() => {
		generation.current++;
		setProjects(persistedProjects);
		if (loadError) setError(loadError);
		setExpanded({});
		setLoaded({});
		setLoading({});
	}, [clientId, persistedProjects, loadError]);

	const persist = useCallback((next: AgentProject[]) => {
		projectsRef.current = next;
		setProjects(next);
		try {
			saveAgentProjects(clientId, next);
			setError(null);
		} catch {
			setError("浏览器无法保存项目索引；项目仍可临时使用。");
		}
	}, [clientId]);

	const loadSessions = useCallback(async (ref: PiCwdRef) => {
		const cwdRef = cwdRefOf(ref);
		const key = projectKey(cwdRef);
		const token = ++generation.current;
		setLoaded((current) => ({ ...current, [key]: true }));
		setLoading((current) => ({ ...current, [key]: true }));
		setErrors((current) => ({ ...current, [key]: null }));
		try {
			const sessions = await pi.sessions.list(clientId, cwdRef) as PiSessionInfo[];
			const withTrees = await Promise.all(sessions.slice(0, 50).map(async (session) => {
				try {
					const detail = await pi.sessions.get(clientId, session.id, cwdRef) as { tree?: PiSessionTreeNode[] };
					return { ...session, tree: detail.tree ?? [] };
				} catch { return { ...session, tree: [] }; }
			}));
			if (generation.current === token) setSessionLists((current) => ({ ...current, [key]: withTrees }));
		} catch (cause) {
			if (generation.current === token) setErrors((current) => ({ ...current, [key]: cause instanceof Error ? cause.message : String(cause) }));
		} finally {
			if (generation.current === token) setLoading((current) => ({ ...current, [key]: false }));
		}
	}, [clientId, pi.sessions]);

	const addProject = useCallback(async (ref: PiCwdRef) => {
		try {
			await files.list(clientId, ref.rootDir, ref.relativePath);
			const next = touchAgentProject(projectsRef.current, ref);
			persist(next);
			onSelectProject(ref);
			setPickerOpen(false);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Client 无法验证项目目录");
		}
	}, [clientId, files, onSelectProject, persist]);

	const toggleProject = (project: AgentProject) => {
		const key = projectKey(project);
		const open = !expanded[key];
		setExpanded((current) => ({ ...current, [key]: open }));
		if (open && !loaded[key]) void loadSessions(project);
	};

	const createTask = async (project: AgentProject) => {
		const cwdRef = cwdRefOf(project);
		onSelectProject(cwdRef);
		try {
			const created = await pi.agent.newSession(clientId, cwdRef) as { sessionId: string };
			onCreated(created.sessionId, cwdRef);
			setExpanded((current) => ({ ...current, [projectKey(cwdRef)]: true }));
			void loadSessions(cwdRef);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "创建任务失败");
		}
	};

	const removeProject = (project: AgentProject) => {
		persist(removeAgentProject(projectsRef.current, project));
		if (selectedCwd && sameProject(selectedCwd, project)) onSelectProject(null);
	};

	return <div className="flex h-full min-h-0 flex-col gap-2" data-testid="agent-project-navigator">
		<div className="flex items-center justify-between px-1.5">
			<h2 className="text-xs font-medium tracking-wide text-muted-foreground">项目</h2>
			<SidebarIconButton label="添加项目" onClick={() => setPickerOpen(true)}>
				<Plus className="h-4 w-4" aria-hidden="true" />
			</SidebarIconButton>
		</div>
		{error && <p role="alert" className="px-1.5 text-xs text-destructive">{error}</p>}
		{projects.length === 0 && <p className="px-1.5 text-xs text-muted-foreground">尚无项目，添加一个目录开始。</p>}
		<div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
			{sortAgentProjects(projects).map((project) => {
				const key = projectKey(project);
				const label = project.relativePath || project.rootDir;
				const groups = groupByDate(sessionLists[key] ?? []);
				return <section key={key}>
					<div className="group flex items-center gap-0.5 rounded-lg px-1.5 py-1 transition hover:bg-secondary/50">
						<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]" aria-expanded={expanded[key] === true} onClick={() => toggleProject(project)}>
							<ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition", expanded[key] && "rotate-90")} aria-hidden="true" />
							<span className="truncate">{label}</span>
							{project.pinned && <Star className="h-3 w-3 shrink-0 fill-current text-amber-400" aria-hidden="true" />}
						</button>
						<div className="flex shrink-0 items-center gap-0.5 opacity-60 transition group-hover:opacity-100 group-focus-within:opacity-100">
							<SidebarIconButton label={`新建任务 ${label}`} onClick={() => void createTask(project)}>
								<MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
							</SidebarIconButton>
							<SidebarIconButton label={project.pinned ? "取消置顶" : "置顶"} onClick={() => persist(toggleAgentProjectPin(projectsRef.current, project))}>
								<Star className={cn("h-3.5 w-3.5", project.pinned && "fill-current text-amber-400")} aria-hidden="true" />
							</SidebarIconButton>
							<SidebarIconButton label="移除项目" onClick={() => removeProject(project)}>
								<X className="h-3.5 w-3.5" aria-hidden="true" />
							</SidebarIconButton>
						</div>
					</div>
					{expanded[key] && <div className="mb-1 space-y-0.5 pl-3">
						{loading[key] && <p className="px-1.5 py-1 text-xs text-muted-foreground">加载会话…</p>}
						{errors[key] && <div className="space-y-1 px-1.5 py-1 text-xs text-destructive"><p>{errors[key]}</p><button type="button" onClick={() => void loadSessions(project)}>重试</button></div>}
						{!loading[key] && !errors[key] && groups.length === 0 && <p className="px-1.5 py-1 text-xs text-muted-foreground">暂无会话</p>}
						{groups.map((group) => <section key={group.label}><h3 className="px-1.5 pb-0.5 pt-2 text-[10px] tracking-wide text-muted-foreground">{group.label}</h3>{group.items.map((session) => { const title = session.name || session.firstMessage || session.id.slice(0, 8); return <div key={session.id}><div className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-secondary/50"><button type="button" className={cn("min-w-0 flex-1 truncate text-left text-[13px]", session.id === activeSessionId && "font-medium")} aria-current={session.id === activeSessionId ? "page" : undefined} onClick={() => { onSelectSession(session.id, cwdRefOf(project)); }}>{title}</button><span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(session.modified)}</span>{(mutableSessionIds.has("*") || mutableSessionIds.has(session.id)) && <SidebarIconButton label={`删除会话 ${title}`} className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => setPendingDelete({ session, project })}><X className="h-3.5 w-3.5" aria-hidden="true" /></SidebarIconButton>}</div>{session.tree.length > 0 && <div className="ml-3 border-l border-border/60 pl-2"><SessionTree nodes={session.tree} onNavigate={(entryId) => onSelectSession(entryId, cwdRefOf(project))} /></div>}</div>; })}</section>)}
					</div>}
				</section>;
			})}
		</div>
		{pendingDelete && <ConfirmTargetDialog
			open
			mode="confirm"
			title="删除会话"
			target={pendingDelete.session.name || pendingDelete.session.firstMessage || pendingDelete.session.id.slice(0, 8)}
			onConfirm={async () => {
				const { session, project } = pendingDelete;
				const cwdRef = cwdRefOf(project);
				setPendingDelete(null);
				try {
					await pi.sessions.delete(clientId, session.id, cwdRef);
					if (activeSessionId === session.id) onSelectProject(null);
					void loadSessions(cwdRef);
				} catch (cause) {
					setErrors((current) => ({ ...current, [projectKey(cwdRef)]: cause instanceof Error ? cause.message : String(cause) }));
				}
			}}
			onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
		/>}
		{!selectedCwd && <p className="text-xs text-muted-foreground">选择项目或新建任务开始对话</p>}
		<Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
				<DialogContent className="p-0">
					<DialogTitle className="sr-only">添加项目</DialogTitle>
					<DialogDescription className="sr-only">选择或浏览一个经过 Client 校验的项目目录。</DialogDescription>
					<PiProjectPicker files={files} clientId={clientId} value={selectedCwd} onSelect={(ref) => void addProject(ref)} open={pickerOpen} onOpenChange={setPickerOpen} />
				</DialogContent>
		</Dialog>
	</div>;
}

/** 左栏入口：Agent 聊天使用多项目索引，机器工作区保留原会话管理界面。 */
export function PiSessionSidebar(props: {
 pi: Pick<PiApi, "sessions" | "agent">;
 files: PiFilesApiLike;
 clientId: string;
 cwdRef: PiCwdRef | null;
 onCwdChange: (ref: PiCwdRef) => void;
 activeSessionId: string | null;
 mutableSessionIds: ReadonlySet<string>;
 onSelectSession: (sessionId: string | null, project?: PiCwdRef) => void;
 onCreated: (sessionId: string, project?: PiCwdRef) => void;
 agentChatLayout?: boolean;
}) {
 const [agentChatProject, setAgentChatProject] = useState<PiCwdRef | null>(props.cwdRef);
 const selectSession = useCallback((sessionId: string | null, project: PiCwdRef) => {
  setAgentChatProject(project);
  props.onCwdChange(project);
  props.onSelectSession(sessionId, project);
 }, [props.onCwdChange, props.onSelectSession]);
 const createSession = useCallback((sessionId: string, project: PiCwdRef) => {
  setAgentChatProject(project);
  props.onCwdChange(project);
  props.onCreated(sessionId, project);
 }, [props.onCwdChange, props.onCreated]);
 if (props.agentChatLayout) return <AgentProjectNavigator
  clientId={props.clientId} files={props.files} pi={props.pi}
  selectedCwd={agentChatProject ?? props.cwdRef}
  activeSessionId={props.activeSessionId} mutableSessionIds={props.mutableSessionIds}
  onSelectProject={(ref) => { setAgentChatProject(ref); if (ref) props.onCwdChange(ref); else props.onSelectSession(null); }}
  onSelectSession={selectSession} onCreated={createSession}
 />;
 return <LegacyPiSessionSidebar {...props} onSelectSession={(id) => props.onSelectSession(id)} onCreated={(id) => props.onCreated(id)} />;
}

/** 左栏：项目选择 + Session 树 + 完整 Session 管理 */
function LegacyPiSessionSidebar({
	pi,
	files,
	clientId,
	cwdRef,
	onCwdChange,
	activeSessionId,
	mutableSessionIds,
	onSelectSession,
	onCreated,
}: {
	pi: Pick<PiApi, "sessions" | "agent">;
	files: PiFilesApiLike;
	clientId: string;
	cwdRef: PiCwdRef | null;
	onCwdChange: (ref: PiCwdRef) => void;
	activeSessionId: string | null;
	/**
	 * 当前身份可管理的 Session ID 集合。包含通配符 `"*"` 表示本 cwd 下所有会话都可管理。
	 * 不在集合内的卡片仅可打开观察。
	 */
	mutableSessionIds: ReadonlySet<string>;
	/**
	 * 选择会话：传入 sessionId 为打开；传入 `null` 为清空当前会话（删除后由父级同步清理对话/详情）。
	 */
	onSelectSession: (sessionId: string | null) => void;
	onCreated: (sessionId: string) => void;
}) {
	const [sessions, setSessions] = useState<SidebarSession[]>([]);
	const [importOpen, setImportOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<
		| { kind: "rename"; session: SidebarSession }
		| { kind: "delete"; session: SidebarSession }
		| null
	>(null);

	const reload = useCallback(async () => {
		if (!cwdRef) return;
		setLoading(true);
		setError(null);
		try {
			const list = (await pi.sessions.list(
				clientId,
				cwdRef,
			)) as PiSessionInfo[];
			const withTree = await Promise.all(
				list.slice(0, 50).map(async (s) => {
					try {
						const detail = (await pi.sessions.get(clientId, s.id, cwdRef)) as {
							tree: PiSessionTreeNode[];
						};
						return { ...s, tree: detail.tree };
					} catch {
						return { ...s, tree: [] };
					}
				}),
			);
			setSessions(withTree);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [pi, clientId, cwdRef]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const createNew = useCallback(async () => {
		if (!cwdRef) return;
		try {
			const { sessionId } = (await pi.agent.newSession(clientId, cwdRef)) as {
				sessionId: string;
			};
			onCreated(sessionId);
			await reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [pi, clientId, cwdRef, onCreated, reload]);

	const submitRename = useCallback(
		async (sessionId: string, name: string) => {
			if (!cwdRef) return;
			try {
				await pi.sessions.rename(clientId, sessionId, cwdRef, name);
				await reload();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[pi, clientId, cwdRef, reload],
	);

	const submitDelete = useCallback(
		async (sessionId: string) => {
			if (!cwdRef) return;
			try {
				await pi.sessions.delete(clientId, sessionId, cwdRef);
				if (activeSessionId === sessionId) onSelectSession(null);
				await reload();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[pi, clientId, cwdRef, reload, activeSessionId, onSelectSession],
	);

	const groups = useMemo(() => groupByDate(sessions), [sessions]);

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			<Button
				type="button"
				disabled={!cwdRef}
				onClick={() => void createNew()}
				className="w-full"
			>
				+ 新建会话
			</Button>

			<Button
				type="button"
				variant="outline"
				onClick={() => setImportOpen(true)}
				className="w-full"
			>
				导入旧会话
			</Button>
			<PiImportDialog
				pi={pi}
				clientId={clientId}
				open={importOpen}
				onOpenChange={setImportOpen}
			/>

			<PiProjectPicker
				files={files}
				clientId={clientId}
				value={cwdRef}
				onSelect={onCwdChange}
			/>

			{error && <div className="text-xs text-destructive">{error}</div>}

			<div className="flex items-center gap-2">
				<span className="text-sm font-medium">会话</span>
				{sessions.length > 0 && (
					<span className="rounded bg-secondary/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
						{sessions.length}
					</span>
				)}
			</div>

			{!cwdRef && (
				<div className="text-xs text-muted-foreground">先选择项目目录</div>
			)}
			{loading && <div className="text-xs text-muted-foreground">加载中…</div>}
			{!loading && cwdRef && sessions.length === 0 && (
				<div className="text-xs text-muted-foreground">暂无会话</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto pr-1">
				{groups.map((group) => (
					<section key={group.key} className="mb-3 last:mb-0">
						<h3 className="sticky top-0 bg-background/80 px-1 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur">
							{group.label}
						</h3>
						<ul className="space-y-0.5">
							{group.items.map((s) => (
								<li key={s.id}>
									<SessionRow
										session={s}
										isActive={s.id === activeSessionId}
										isMutable={
											mutableSessionIds.has(s.id) || mutableSessionIds.has("*")
										}
										onSelect={() => onSelectSession(s.id)}
										onRequestRename={() =>
											setPending({ kind: "rename", session: s })
										}
										onRequestDelete={() =>
											setPending({ kind: "delete", session: s })
										}
									/>
									{s.tree.length > 0 && (
										<div className="ml-4 mt-0.5 border-l border-border/60 pl-2">
											<SessionTree
												nodes={s.tree}
												onNavigate={onSelectSession}
											/>
										</div>
									)}
								</li>
							))}
						</ul>
					</section>
				))}
			</div>

			{pending?.kind === "rename" && (
				<RenameDialog
					session={pending.session}
					onCancel={() => setPending(null)}
					onConfirm={(name) => {
						const sid = pending.session.id;
						setPending(null);
						void submitRename(sid, name);
					}}
				/>
			)}
			{pending?.kind === "delete" && (
				<ConfirmTargetDialog
					open
					mode="confirm"
					title="删除会话"
					target={
						pending.session.name ||
						pending.session.firstMessage ||
						pending.session.id.slice(0, 8)
					}
					onConfirm={() => {
						const sid = pending.session.id;
						setPending(null);
						void submitDelete(sid);
					}}
					onOpenChange={(o) => {
						if (!o) setPending(null);
					}}
				/>
			)}
		</div>
	);
}

function RenameDialog({
	session,
	onCancel,
	onConfirm,
}: {
	session: SidebarSession;
	onCancel: () => void;
	onConfirm: (name: string) => void;
}) {
	const [value, setValue] = useState(session.name ?? "");
	const trimmed = value.trim();
	const changed = trimmed !== (session.name ?? "");

	return (
		<Dialog open onOpenChange={(o) => !o && onCancel()}>
			<DialogContent>
				<DialogTitle>重命名会话</DialogTitle>
				<DialogDescription>为该会话设置一个新的显示名称。</DialogDescription>
				<div className="mt-5 space-y-2">
					<Label htmlFor="rename-session">新名称</Label>
					<Input
						id="rename-session"
						autoFocus
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && trimmed) onConfirm(trimmed);
						}}
						maxLength={120}
					/>
				</div>
				<div className="mt-6 flex justify-end gap-3">
					<Button type="button" variant="ghost" onClick={onCancel}>
						取消
					</Button>
					<Button
						type="button"
						disabled={!trimmed || !changed}
						onClick={() => onConfirm(trimmed)}
					>
						保存
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function SessionRow({
	session,
	isActive,
	isMutable,
	onSelect,
	onRequestRename,
	onRequestDelete,
}: {
	session: SidebarSession;
	isActive: boolean;
	isMutable: boolean;
	onSelect: () => void;
	onRequestRename: () => void;
	onRequestDelete: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const onDoc = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [menuOpen]);

	const title = session.name || session.firstMessage || "(无标题)";

	return (
		<div className="group relative">
			<button
				type="button"
				className={cn(
					"block min-h-11 w-full cursor-pointer rounded-md px-2 py-1.5 text-left transition",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
					isActive ? "bg-primary/10" : "hover:bg-secondary/60",
				)}
				onClick={onSelect}
				title={title}
				aria-label={`打开会话：${title}`}
			>
				<div className={cn("flex items-center gap-2", isMutable && "pr-7")}>
					<span
						className={cn(
							"size-1.5 shrink-0 rounded-full",
							session.running ? "bg-green-500" : "bg-muted-foreground/40",
						)}
						title={session.running ? "运行中" : "空闲"}
					/>
					<span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
						{title}
					</span>
				</div>
				<div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[10px] text-muted-foreground">
					<span>{relativeTime(session.modified)}</span>
					{session.messageCount > 0 && (
						<span className="rounded bg-secondary/70 px-1.5 py-0.5">
							{session.messageCount} msgs
						</span>
					)}
				</div>
			</button>
			{isMutable && (
				<div className="absolute right-1.5 top-1" ref={menuRef}>
					<button
						type="button"
						onClick={() => setMenuOpen((v) => !v)}
						className={cn(
							"rounded px-1.5 py-0.5 text-xs text-muted-foreground transition",
							"hover:bg-secondary hover:text-foreground",
							menuOpen && "bg-secondary text-foreground",
						)}
						aria-label="操作"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
					>
						⋯
					</button>
					{menuOpen && (
						<div
							role="menu"
							className="absolute right-0 top-full z-10 mt-1 min-w-28 overflow-hidden rounded-md border border-border bg-card py-1 shadow-xl"
						>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setMenuOpen(false);
									onRequestRename();
								}}
								className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-secondary/70"
							>
								重命名
							</button>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setMenuOpen(false);
									onRequestDelete();
								}}
								className="block w-full px-3 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10"
							>
								删除
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function SessionTree({
	nodes,
	onNavigate,
	depth = 0,
}: {
	nodes: PiSessionTreeNode[];
	onNavigate: (entryId: string) => void;
	depth?: number;
}) {
	return (
		<div className="space-y-0.5" style={{ paddingLeft: depth > 0 ? 10 : 0 }}>
			{nodes.map((node) => (
				<SessionTreeNode
					key={node.id}
					node={node}
					onNavigate={onNavigate}
					depth={depth}
				/>
			))}
		</div>
	);
}

/** 分支节点：子分支默认折叠（长 fork 链会话避免上千 DOM 节点） */
function SessionTreeNode({
	node,
	onNavigate,
	depth,
}: {
	node: PiSessionTreeNode;
	onNavigate: (entryId: string) => void;
	depth: number;
}) {
	const [open, setOpen] = useState(false);
	const hasChildren = node.children.length > 0;
	return (
		<div>
			<div className="flex items-center gap-1">
				{hasChildren ? (
					<button
						type="button"
						className="w-4 shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
						onClick={() => setOpen((v) => !v)}
						aria-label={open ? "收起分支" : "展开分支"}
					>
						{open ? "▾" : "▸"}
					</button>
				) : (
					<span className="w-4 shrink-0" />
				)}
				<button
					type="button"
					className={`block w-full truncate rounded px-0.5 py-0.5 text-left text-[10px] ${
						node.running ? "text-green-500" : "text-muted-foreground"
					}`}
					onClick={() => onNavigate(node.id)}
					title="分支节点（会话内导航）"
				>
					{node.running ? "●" : "○"}{" "}
					{node.name || `分支 ${node.id.slice(0, 6)}`}
				</button>
			</div>
			{open && hasChildren && (
				<SessionTree
					nodes={node.children}
					onNavigate={onNavigate}
					depth={depth + 1}
				/>
			)}
		</div>
	);
}
