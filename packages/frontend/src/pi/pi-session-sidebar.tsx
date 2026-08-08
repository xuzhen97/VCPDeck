import { useCallback, useEffect, useState } from "react";
import type { PiCwdRef, PiSessionInfo, PiSessionTreeNode } from "@vcpdeck/shared";
import type { PiApi } from "@vcpdeck/sdk";
import { PiProjectPicker, type PiFilesApiLike } from "./pi-project-picker.js";
import { Button } from "@/components/ui/button";

interface SidebarSession extends PiSessionInfo {
	tree: PiSessionTreeNode[];
}

/** 左栏：项目选择 + Session 树 + 完整 Session 管理 */
export function PiSessionSidebar({
	pi,
	files,
	clientId,
	cwdRef,
	onCwdChange,
	activeSessionId,
	onSelectSession,
	onCreated,
}: {
	pi: Pick<PiApi, "sessions" | "agent">;
	files: PiFilesApiLike;
	clientId: string;
	cwdRef: PiCwdRef | null;
	onCwdChange: (ref: PiCwdRef) => void;
	activeSessionId: string | null;
	onSelectSession: (sessionId: string) => void;
	onCreated: (sessionId: string) => void;
}) {
	const [sessions, setSessions] = useState<SidebarSession[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		if (!cwdRef) return;
		setLoading(true);
		setError(null);
		try {
			// Server 返回裸数组（GET /pi/sessions），直接作为列表使用
			const list = (await pi.sessions.list(clientId, cwdRef)) as PiSessionInfo[];
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

	const rename = useCallback(
		async (sessionId: string) => {
			const name = window.prompt("新名称");
			if (!name || !cwdRef) return;
			try {
				await pi.sessions.rename(clientId, sessionId, cwdRef, name);
				await reload();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[pi, clientId, cwdRef, reload],
	);

	const remove = useCallback(
		async (sessionId: string) => {
			if (!window.confirm("删除该 Session？此操作不可撤销。")) return;
			if (!cwdRef) return;
			try {
				await pi.sessions.delete(clientId, sessionId, cwdRef);
				if (activeSessionId === sessionId) onSelectSession("");
				await reload();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[pi, clientId, cwdRef, reload, activeSessionId, onSelectSession],
	);

	const fork = useCallback(
		async (sessionId: string) => {
			const messageId = window.prompt("从哪条消息 fork？（消息 ID）");
			if (!messageId || !cwdRef) return;
			try {
				const result = (await pi.sessions.fork(clientId, sessionId, cwdRef, messageId)) as {
					sessionId: string;
				};
				onCreated(result.sessionId);
				await reload();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[pi, clientId, cwdRef, onCreated, reload],
	);

	const clone = useCallback(
		async (sessionId: string) => {
			if (!cwdRef) return;
			try {
				const result = (await pi.sessions.clone(clientId, sessionId, cwdRef)) as {
					sessionId: string;
				};
				onCreated(result.sessionId);
				await reload();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[pi, clientId, cwdRef, onCreated, reload],
	);

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			<PiProjectPicker
				files={files}
				clientId={clientId}
				value={cwdRef}
				onSelect={onCwdChange}
			/>

			{error && <div className="text-xs text-red-500">{error}</div>}

			<div className="flex items-center justify-between">
				<span className="text-sm font-medium">会话</span>
				<Button type="button" size="sm" disabled={!cwdRef} onClick={() => void createNew()}>
					新建
				</Button>
			</div>

			{!cwdRef && (
				<div className="text-xs text-muted-foreground">先选择项目目录</div>
			)}
			{loading && <div className="text-xs text-muted-foreground">加载中…</div>}
			{sessions.length === 0 && !loading && cwdRef && (
				<div className="text-xs text-muted-foreground">暂无会话</div>
			)}

			<div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
				{sessions.map((s) => (
					<div
						key={s.id}
						className={`rounded border p-2 ${
							s.id === activeSessionId ? "border-primary" : "border-border"
						}`}
					>
						<button
							type="button"
							className="block w-full text-left"
							onClick={() => onSelectSession(s.id)}
						>
							<div className="flex items-center gap-1.5">
								<span className="truncate text-xs font-medium">
									{s.name || s.firstMessage || "(无标题)"}
								</span>
								{s.running && (
									<span className="size-1.5 shrink-0 rounded-full bg-green-500" aria-label="运行中" />
								)}
							</div>
							<div className="mt-0.5 text-[10px] text-muted-foreground">
								{s.messageCount} 条消息 · {new Date(s.modified).toLocaleString()}
							</div>
						</button>
						<div className="mt-1 flex gap-1">
							<button
								type="button"
								className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary/60"
								onClick={() => void rename(s.id)}
							>
								重命名
							</button>
							<button
								type="button"
								className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary/60"
								onClick={() => void clone(s.id)}
							>
								克隆
							</button>
							<button
								type="button"
								className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary/60"
								onClick={() => void fork(s.id)}
							>
								Fork
							</button>
							<button
								type="button"
								className="ml-auto rounded px-1 py-0.5 text-[10px] text-red-500 hover:bg-red-500/10"
								onClick={() => void remove(s.id)}
							>
								删除
							</button>
						</div>
						{s.tree.length > 0 && (
							<div className="mt-1 border-t border-border/60 pt-1">
								<SessionTree
									nodes={s.tree}
									onNavigate={onSelectSession}
								/>
							</div>
						)}
					</div>
				))}
			</div>
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
				<div key={node.id}>
					<button
						type="button"
						className={`block w-full truncate rounded px-1 py-0.5 text-left text-[10px] ${
							node.running ? "text-green-500" : "text-muted-foreground"
						}`}
						onClick={() => onNavigate(node.id)}
						title="分支节点（会话内导航）"
					>
						{node.running ? "●" : "○"} {node.name || `分支 ${node.id.slice(0, 6)}`}
					</button>
					{node.children.length > 0 && (
						<SessionTree
							nodes={node.children}
							onNavigate={onNavigate}
							depth={depth + 1}
						/>
					)}
				</div>
			))}
		</div>
	);
}
