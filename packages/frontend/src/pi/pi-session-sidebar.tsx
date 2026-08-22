import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	PiCwdRef,
	PiSessionInfo,
	PiSessionTreeNode,
} from "@vcpdeck/shared";
import type { PiApi } from "@vcpdeck/sdk";
import { PiProjectPicker, type PiFilesApiLike } from "./pi-project-picker.js";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmTargetDialog } from "@/components/confirm-target-dialog";
import { cn } from "@/lib/utils";

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

/** 左栏：项目选择 + Session 树 + 完整 Session 管理 */
export function PiSessionSidebar({
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
