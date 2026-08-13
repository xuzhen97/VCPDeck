import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/async-state";
import type { TerminalSessionInfo, TerminalShellInfo } from "@vcpdeck/shared";
import { TerminalLimits } from "@vcpdeck/shared";
import { createTerminalSocket, createAppSocket, type TerminalSocketEvents } from "../terminal/terminal-socket.js";
import { useTerminalSession, type TerminalSessionState } from "../terminal/use-terminal-session.js";
import { TerminalView, type TerminalViewHandle, type XtermAdapter, type ResizeObserverLike } from "../terminal/terminal-view.js";
import { TerminalTabs } from "../terminal/terminal-tabs.js";
import { TerminalControl } from "../terminal/terminal-control.js";
import { TerminalAuditDialog } from "../terminal/terminal-audit-dialog.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const ENDED = new Set(["exited", "interrupted", "expired", "closed", "error"]);

/** 单会话子标签：hook + xterm 视图 + 控制条。 */
function SessionTab({
	clientId,
	session,
	socket,
	active,
	onRequestClose,
	onRequestAudit,
	viewAdapterFactory,
	viewResizeObserverFactory,
}: {
	clientId: string;
	session: TerminalSessionInfo;
	socket: TerminalSocketEvents;
	active: boolean;
	onRequestClose: () => void;
	onRequestAudit: () => void;
	viewAdapterFactory?: () => XtermAdapter;
	viewResizeObserverFactory?: () => ResizeObserverLike;
}) {
	const viewRef = useRef<TerminalViewHandle | null>(null);
	// 视图未就绪时的写入缓冲
	const pendingView = useRef("");
	const [viewReady, setViewReady] = useState(false);
	const view = useMemo(
		() => ({
			write: (data: string) => {
				if (viewRef.current) viewRef.current.write(data);
				else pendingView.current += data;
			},
			reset: () => {
				pendingView.current = "";
				viewRef.current?.reset();
			},
		}),
		[],
	);
	const sessionHook = useTerminalSession({
		socket,
		clientId,
		sessionId: session.sessionId,
		view,
	});
	const state: TerminalSessionState = sessionHook.state;

	// 视图就绪后冲刷缓冲
	useEffect(() => {
		if (viewReady && pendingView.current) {
			viewRef.current?.write(pendingView.current);
			pendingView.current = "";
		}
	}, [viewReady]);

	return (
		<div className="flex h-full min-h-0 flex-col" role="tabpanel" hidden={!active}>
			<TerminalControl
				state={state}
				shellLabel={session.shellLabel}
				onTakeover={sessionHook.handleTakeover}
				onClose={onRequestClose}
				onAudit={onRequestAudit}
			/>
			<div className="min-h-0 flex-1 bg-black">
				<TerminalView
					ref={viewRef}
					onReady={() => setViewReady(true)}
					onData={sessionHook.handleInput}
					onResize={sessionHook.handleResize}
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
	const [sessions, setSessions] = useState<TerminalSessionInfo[] | null>(null);
	const [shells, setShells] = useState<TerminalShellInfo[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [closeTarget, setCloseTarget] = useState<TerminalSessionInfo | null>(null);
	const [auditTarget, setAuditTarget] = useState<TerminalSessionInfo | null>(null);
	const [closing, setClosing] = useState(false);

	const reload = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const [list, shellList] = await Promise.all([
					sdk.terminals.list(clientId, { page: 1, pageSize: 50 }, signal),
					sdk.terminals.shells(clientId, signal),
				]);
				setSessions(list.data);
				setShells(shellList);
				setError(null);
				setActiveId((current) => {
					if (current && list.data.some((s) => s.sessionId === current)) return current;
					const first = list.data.find((s) => !ENDED.has(s.status)) ?? list.data[0];
					return first?.sessionId ?? null;
				});
			} catch (err) {
				const code = (err as { code?: unknown }).code;
				setError(
					typeof code === "string"
						? code
						: (err as { message?: string }).message ?? "无法加载终端列表",
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
					cols: DEFAULT_COLS,
					rows: DEFAULT_ROWS,
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
			setCloseTarget(null);
			await reload();
		} catch {
			/* 关闭失败保留对话框由用户重试 */
		} finally {
			setClosing(false);
		}
	}, [sdk, clientId, closeTarget, reload]);

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

	const active = sessions.find((s) => s.sessionId === activeId) ?? null;
	const activeCount = sessions.filter((s) => !ENDED.has(s.status)).length;
	const canCreate = activeCount < TerminalLimits.maxSessionsPerClient;

	return (
		<div data-testid="terminal-panel" className="flex h-full min-h-0 flex-col">
			<TerminalTabs
				sessions={sessions}
				shells={shells}
				activeId={activeId}
				onSelect={setActiveId}
				onNew={createSession}
				onCloseTab={(sessionId) => {
					const target = sessions.find((s) => s.sessionId === sessionId) ?? null;
					setCloseTarget(target);
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
				{sessions.map((session) => (
					<SessionTab
						key={session.sessionId}
						clientId={clientId}
						session={session}
						socket={socket}
						active={session.sessionId === activeId}
						onRequestClose={() => setCloseTarget(session)}
						onRequestAudit={() => setAuditTarget(session)}
						viewAdapterFactory={viewAdapterFactory}
						viewResizeObserverFactory={viewResizeObserverFactory}
					/>
				))}
			</div>

			<Dialog open={closeTarget !== null} onOpenChange={(open) => !open && setCloseTarget(null)}>
				<DialogContent>
					<DialogTitle>关闭终端？</DialogTitle>
					<DialogDescription>
						将结束远端 Shell 及其子进程。会话关闭后无法恢复（可重新新建）。
					</DialogDescription>
					<div className="flex justify-end gap-2 pt-2">
						<Button variant="outline" onClick={() => setCloseTarget(null)}>
							取消
						</Button>
						<Button variant="destructive" disabled={closing} onClick={() => void confirmClose()}>
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
