import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/async-state";
import type { TerminalSessionInfo, TerminalShellInfo } from "@vcpdeck/shared";
import { TerminalLimits } from "@vcpdeck/shared";
import {
	createTerminalSocket,
	createAppSocket,
	type TerminalSocketEvents,
} from "../terminal/terminal-socket.js";
import {
	useTerminalSession,
	type TerminalSessionState,
} from "../terminal/use-terminal-session.js";
import {
	TerminalView,
	type TerminalViewHandle,
	type XtermAdapter,
	type ResizeObserverLike,
} from "../terminal/terminal-view.js";
import { TerminalTabs } from "../terminal/terminal-tabs.js";
import { TerminalControl } from "../terminal/terminal-control.js";
import { TerminalAuditDialog } from "../terminal/terminal-audit-dialog.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const ENDED = new Set(["exited", "interrupted", "expired", "closed", "error"]);

const DISMISSED_PREFIX = "vcpdeck:term:dismissed:";

/** 读取本机已清除的终态会话 id（localStorage，按 client 隔离）。 */
function loadDismissed(clientId: string): Set<string> {
	try {
		const raw = window.localStorage.getItem(`${DISMISSED_PREFIX}${clientId}`);
		return new Set(raw ? (JSON.parse(raw) as string[]) : []);
	} catch {
		return new Set();
	}
}

function saveDismissed(clientId: string, ids: Set<string>): void {
	try {
		window.localStorage.setItem(
			`${DISMISSED_PREFIX}${clientId}`,
			JSON.stringify([...ids]),
		);
	} catch {
		/* 存储不可用（隐私模式等）时忽略：本次会话内仍有效 */
	}
}

/** 单会话子标签：hook + xterm 视图 + 控制条。 */
function SessionTab({
	clientId,
	session,
	socket,
	active,
	onSizeChange,
	viewAdapterFactory,
	viewResizeObserverFactory,
}: {
	clientId: string;
	session: TerminalSessionInfo;
	socket: TerminalSocketEvents;
	active: boolean;
	onSizeChange: (cols: number, rows: number) => void;
	viewAdapterFactory?: () => XtermAdapter;
	viewResizeObserverFactory?: () => ResizeObserverLike;
}) {
	const viewRef = useRef<TerminalViewHandle | null>(null);
	// 视图未就绪时的写入缓冲
	const pendingView = useRef("");
	const [viewReady, setViewReady] = useState(false);
	const view = useMemo(
		() => ({
			write: (data: string, cb?: () => void) => {
				if (viewRef.current) viewRef.current.write(data, cb);
				else {
					pendingView.current += data;
					cb?.();
				}
			},
			reset: () => {
				pendingView.current = "";
				viewRef.current?.reset();
			},
		}),
		[],
	);
	const sessionHookRef = useRef<ReturnType<typeof useTerminalSession> | null>(
		null,
	);
	const sessionHook = useTerminalSession({
		socket,
		clientId,
		sessionId: session.sessionId,
		view,
		onGainedControl: () => {
			// 接管/恢复操作权后：fit 并下发权威尺寸（设计 10.4）
			const size = viewRef.current?.fit() ?? null;
			if (size) {
				onSizeChange(size.cols, size.rows);
				sessionHookRef.current?.handleResize(size.cols, size.rows);
			}
		},
	});
	sessionHookRef.current = sessionHook;
	const state: TerminalSessionState = sessionHook.state;

	// 视图就绪后冲刷缓冲
	useEffect(() => {
		if (viewReady && pendingView.current) {
			viewRef.current?.write(pendingView.current);
			pendingView.current = "";
		}
	}, [viewReady]);

	return (
		<div
			className="flex h-full min-h-0 flex-col"
			role="tabpanel"
			hidden={!active}
		>
			<TerminalControl
				state={state}
				shellLabel={session.shellLabel}
				onTakeover={sessionHook.handleTakeover}
			/>
			<div className="min-h-0 flex-1 bg-black">
				<TerminalView
					ref={viewRef}
					onReady={() => setViewReady(true)}
					onData={sessionHook.handleInput}
					onResize={(cols, rows) => {
						onSizeChange(cols, rows);
						sessionHook.handleResize(cols, rows);
					}}
					readOnly={state.mode !== "operator"}
					adapterFactory={viewAdapterFactory}
					resizeObserverFactory={viewResizeObserverFactory}
				/>
			</div>
		</div>
	);
}

/** 机器终端面板：多会话子标签、Shell 选择、单写多读与最小审计入口。 */
export function TerminalPanel({
	clientId,
	socketFactory = createAppSocket,
	viewAdapterFactory,
	viewResizeObserverFactory,
}: {
	clientId: string;
	socketFactory?: () => ReturnType<typeof createAppSocket>;
	viewAdapterFactory?: () => XtermAdapter;
	viewResizeObserverFactory?: () => ResizeObserverLike;
}) {
	const sdk = useSdk();
	const [socket] = useState(() => createTerminalSocket(socketFactory()));
	// 已清除的终态会话（localStorage 持久化，刷新/新建后不复活）
	const dismissedRef = useRef<Set<string>>(loadDismissed(clientId));
	const [sessions, setSessions] = useState<TerminalSessionInfo[] | null>(null);
	const [shells, setShells] = useState<TerminalShellInfo[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [closeTarget, setCloseTarget] = useState<TerminalSessionInfo | null>(
		null,
	);
	const [auditTarget, setAuditTarget] = useState<TerminalSessionInfo | null>(
		null,
	);
	const [closing, setClosing] = useState(false);
	// 终端放大到整页（fixed 覆盖视口）
	const [expanded, setExpanded] = useState(false);
	// 最近一次容器 fit 尺寸（创建会话时使用；无记录用安全默认）
	const sizeRef = useRef({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
	const handleSizeChange = useCallback((cols: number, rows: number) => {
		sizeRef.current = { cols, rows };
	}, []);

	const reload = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const [list, shellList] = await Promise.all([
					sdk.terminals.list(clientId, { page: 1, pageSize: 50 }, signal),
					sdk.terminals.shells(clientId, signal),
				]);
				const data = list.data.filter(
					(s) => !dismissedRef.current.has(s.sessionId),
				);
				setSessions(data);
				setShells(shellList);
				setError(null);
				setActiveId((current) => {
					if (current && data.some((s) => s.sessionId === current))
						return current;
					const first = data.find((s) => !ENDED.has(s.status)) ?? data[0];
					return first?.sessionId ?? null;
				});
			} catch (err) {
				const code = (err as { code?: unknown }).code;
				setError(
					typeof code === "string"
						? code
						: ((err as { message?: string }).message ?? "无法加载终端列表"),
				);
			}
		},
		[sdk, clientId],
	);

	useEffect(() => {
		const controller = new AbortController();
		void reload(controller.signal);
		return () => controller.abort();
	}, [reload]);

	const createSession = useCallback(
		async (shellId: string) => {
			try {
				const created = await sdk.terminals.create(clientId, {
					shellId,
					cols: sizeRef.current.cols,
					rows: sizeRef.current.rows,
				});
				setActiveId(created.sessionId);
				await reload();
			} catch (err) {
				const code = (err as { code?: unknown }).code;
				setError(typeof code === "string" ? code : "终端创建失败");
			}
		},
		[sdk, clientId, reload],
	);

	const confirmClose = useCallback(async () => {
		if (!closeTarget) return;
		setClosing(true);
		try {
			await sdk.terminals.remove(clientId, closeTarget.sessionId);
			// 关闭即销毁 tab：标记为已清除（reload 过滤 + 刷新不复活），不再显示 closed 状态等二次点击
			const next = new Set(dismissedRef.current);
			next.add(closeTarget.sessionId);
			dismissedRef.current = next;
			saveDismissed(clientId, next);
			setCloseTarget(null);
			await reload();
		} catch {
			/* 关闭失败保留对话框由用户重试 */
		} finally {
			setClosing(false);
		}
	}, [sdk, clientId, closeTarget, reload]);

	// 存活会话：弹确认框走 DELETE；终态会话：清除标签并持久化（远端已结束，DELETE 是幂等空操作，行保留供审计）
	const dismissOrClose = useCallback(
		(session: TerminalSessionInfo) => {
			if (!ENDED.has(session.status)) {
				setCloseTarget(session);
				return;
			}
			if (sessions === null) return;
			const nextDismissed = new Set(dismissedRef.current);
			nextDismissed.add(session.sessionId);
			dismissedRef.current = nextDismissed;
			saveDismissed(clientId, nextDismissed);
			const next = sessions.filter((s) => s.sessionId !== session.sessionId);
			setSessions(next);
			setActiveId((current) => {
				if (current !== session.sessionId) return current;
				return (
					next.find((s) => !ENDED.has(s.status))?.sessionId ??
					next[0]?.sessionId ??
					null
				);
			});
		},
		[clientId, sessions],
	);

	if (error) {
		return (
			<div className="p-4">
				<ErrorState
					message={`终端不可用：${error}`}
					onRetry={() => {
						setError(null);
						void reload();
					}}
				/>
			</div>
		);
	}
	if (!sessions) return <LoadingState label="正在加载终端…" />;

	const activeCount = sessions.filter((s) => !ENDED.has(s.status)).length;
	const canCreate = activeCount < TerminalLimits.maxSessionsPerClient;

	return (
		<div
			data-testid="terminal-panel"
			className={`flex h-full min-h-0 flex-col ${
				expanded ? "fixed inset-0 z-50 bg-background" : ""
			}`}
		>
			<TerminalTabs
				sessions={sessions}
				shells={shells}
				activeId={activeId}
				onSelect={setActiveId}
				onNew={createSession}
				expanded={expanded}
				onToggleExpand={() => setExpanded((v) => !v)}
				onCloseTab={(sessionId) => {
					const target =
						sessions.find((s) => s.sessionId === sessionId) ?? null;
					if (target) dismissOrClose(target);
				}}
				onAudit={(sessionId) => {
					const target =
						sessions.find((s) => s.sessionId === sessionId) ?? null;
					if (target) setAuditTarget(target);
				}}
				canCreate={canCreate}
			/>
			<div className="min-h-0 flex-1">
				{sessions.length === 0 && (
					<div className="flex h-full items-center justify-center">
						<div className="text-center">
							<p className="text-sm text-muted-foreground">还没有终端会话</p>
							<p className="mt-1 text-xs text-muted-foreground/70">
								点击右上角“新建”选择 Shell 启动交互终端。
							</p>
						</div>
					</div>
				)}
				{sessions.map((session) =>
					ENDED.has(session.status) ? (
						// 终态会话：不占用 xterm 实例（设计 13.2），展示状态与审计/清除入口
						<div
							key={session.sessionId}
							role="tabpanel"
							hidden={session.sessionId !== activeId}
							className="flex h-full min-h-0 flex-col"
						>
							<TerminalControl
								state={{
									phase: "ended",
									mode: "viewer",
									operatorName: null,
									controlProtectedUntil: null,
									canTakeover: false,
									lastSeq: 0,
									historyTruncated: false,
									status: session.status,
									error: null,
								}}
								shellLabel={session.shellLabel}
								onTakeover={() => {}}
							/>
							<div className="flex min-h-0 flex-1 items-center justify-center bg-black text-sm text-muted-foreground">
								会话已结束，无法恢复
							</div>
						</div>
					) : (
						<SessionTab
							key={session.sessionId}
							clientId={clientId}
							session={session}
							socket={socket}
							active={session.sessionId === activeId}
							onSizeChange={handleSizeChange}
							viewAdapterFactory={viewAdapterFactory}
							viewResizeObserverFactory={viewResizeObserverFactory}
						/>
					),
				)}
			</div>

			<Dialog
				open={closeTarget !== null}
				onOpenChange={(open) => !open && setCloseTarget(null)}
			>
				<DialogContent>
					<DialogTitle>关闭终端？</DialogTitle>
					<DialogDescription>
						将结束远端 Shell 及其子进程。会话关闭后无法恢复（可重新新建）。
					</DialogDescription>
					<div className="flex justify-end gap-2 pt-2">
						<Button variant="outline" onClick={() => setCloseTarget(null)}>
							取消
						</Button>
						<Button
							variant="destructive"
							disabled={closing}
							onClick={() => void confirmClose()}
						>
							确认关闭
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			<TerminalAuditDialog
				clientId={clientId}
				sessionId={auditTarget?.sessionId ?? null}
				open={auditTarget !== null}
				onOpenChange={(open) => !open && setAuditTarget(null)}
			/>
		</div>
	);
}
