import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
	ArrowRight,
	History,
	Monitor,
	Play,
	Plus,
	RotateCw,
	RotateCcw,
} from "lucide-react";
import {
	REMOTE_DEV_TERMINAL_STATES,
	type ClientInfo,
	type RemoteDevSessionInfo,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	agentStateBadge,
	cleanupLabel,
	formatRelative,
	formatTime,
	isTerminalState,
	sessionStateBadge,
} from "../remote-dev/presentation.js";

/** 与 Server 共用同一份终态集合：只有终态且带 ACP 上下文时才可续接。 */
const RESUMABLE_STATES: readonly string[] = REMOTE_DEV_TERMINAL_STATES;

/** 仍在运行、可以直接进去的状态。 */
const OPENABLE_STATES = ["starting", "active", "detached"];

const STATE_OPTIONS = [
	{ value: "", label: "全部状态" },
	{ value: "active", label: "运行中" },
	{ value: "detached", label: "未附着" },
	{ value: "closed", label: "已结束" },
	{ value: "failed", label: "失败" },
	{ value: "interrupted", label: "已中断" },
];

/**
 * 开发会话历史。
 *
 * 只读列表 + 两个入口：仍在运行的会话可以「打开」继续操作；已结束但带 ACP 上下文的
 * 会话可以「继续」——那会新建一条 RDS 会话并复用原 ACP sessionId。
 */
export function RemoteDevSessionsPage() {
	const sdk = useSdk();
	const navigate = useNavigate();
	const [clients, setClients] = useState<ClientInfo[] | null>(null);
	const [sessions, setSessions] = useState<RemoteDevSessionInfo[] | null>(null);
	const [clientId, setClientId] = useState("");
	const [state, setState] = useState("");
	const [page, setPage] = useState(1);
	const [totalPages, setTotalPages] = useState(1);
	const [total, setTotal] = useState(0);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const [clientList, sessionPage] = await Promise.all([
					sdk.clients.list(signal),
					sdk.remoteDev.list(
						{
							...(clientId ? { clientId } : {}),
							...(state ? { state } : {}),
							page,
							pageSize: 20,
						},
						signal,
					),
				]);
				if (signal?.aborted) return;
				setClients(clientList);
				setSessions(sessionPage.data);
				setTotalPages(Math.max(1, sessionPage.totalPages));
				setTotal(sessionPage.total);
				setError(null);
			} catch {
				if (!signal?.aborted) setError("无法加载开发会话历史");
			}
		},
		[sdk, clientId, state, page],
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	if (error && clients === null) {
		return <ErrorState message={error} />;
	}
	if (clients === null || sessions === null) {
		return <LoadingState label="正在加载开发会话历史…" />;
	}

	const clientName = (id: string) =>
		clients.find((client) => client.clientId === id)?.name ?? id;
	const filtered = clientId !== "" || state !== "";

	return (
		<div className="space-y-4">
			<PageHeading
				title="会话历史"
				description="RDS 是自动化控制台：批量、脚本、远程冒烟与审计都在这里。需要坐下来写代码时，用机器详情页的「远程 DSH」打开完整 DSH 界面。"
				actions={
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" onClick={() => void load()}>
							<RotateCw className="size-3.5" aria-hidden="true" />
							刷新
						</Button>
						<Button size="sm" onClick={() => navigate("/remote-dev/new")}>
							<Plus className="size-3.5" aria-hidden="true" />
							新建会话
						</Button>
					</div>
				}
			/>

			<Card>
				<CardContent className="space-y-4 pt-6">
					<div className="flex flex-wrap items-end gap-3">
						<label className="text-sm">
							<span className="mb-1.5 block font-medium text-muted-foreground">
								机器
							</span>
							<select
								className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
								value={clientId}
								onChange={(event) => {
									setClientId(event.target.value);
									setPage(1);
								}}
							>
								<option value="">全部机器</option>
								{clients.map((client) => (
									<option key={client.clientId} value={client.clientId}>
										{client.name} ({client.hostname})
									</option>
								))}
							</select>
						</label>
						<label className="text-sm">
							<span className="mb-1.5 block font-medium text-muted-foreground">
								状态
							</span>
							<select
								className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
								value={state}
								onChange={(event) => {
									setState(event.target.value);
									setPage(1);
								}}
							>
								{STATE_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</label>
						<p className="ml-auto text-sm text-muted-foreground">
							共 {total} 条
						</p>
					</div>

					{error && <p className="text-sm text-destructive">{error}</p>}

					{sessions.length === 0 ? (
						<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-10 text-center">
							<History className="size-7 text-muted-foreground" aria-hidden="true" />
							<div className="space-y-1">
								<p className="text-sm font-medium">还没有开发会话</p>
								<p className="max-w-md text-sm text-muted-foreground">
									{filtered
										? "当前筛选条件下没有会话，换个机器或状态看看。"
										: "创建一条会话就能在这台机器上远程驱动 agent。会话结束后只要保留了 agent 上下文，随时可以「继续」。"}
								</p>
							</div>
							{!filtered && (
								<Button size="sm" onClick={() => navigate("/remote-dev/new")}>
									新建会话
								</Button>
							)}
						</div>
					) : (
						<ul className="space-y-2">
							{sessions.map((session) => {
								const badge = sessionStateBadge(session.state);
								const agent = agentStateBadge(session.agentStatus);
								const terminal = isTerminalState(session.state);
								const cleanup = terminal
									? cleanupLabel(session.cleanupStatus)
									: null;
								const resumable =
									session.acpSessionId !== undefined &&
									RESUMABLE_STATES.includes(session.state);
								const openable = OPENABLE_STATES.includes(session.state);
								return (
									<li
										key={session.sessionId}
										className="flex flex-col gap-3 rounded-xl border border-border/60 px-4 py-3 transition hover:border-border sm:flex-row sm:items-center sm:justify-between"
									>
										<div className="min-w-0 space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-mono text-xs">{session.sessionId}</span>
												<StatusChip label={badge.label} tone={badge.tone} />
												<StatusChip label={`agent ${agent.label}`} tone={agent.tone} />
												{cleanup && (
													<StatusChip label={cleanup} tone="warning" />
												)}
											</div>
											<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
												<span className="flex items-center gap-1.5">
													<Monitor className="size-3.5" aria-hidden="true" />
													{clientName(session.clientId)}
												</span>
												<span
													className="max-w-[24rem] truncate font-mono"
													title={session.workspaceRoot}
												>
													{session.workspaceRoot}
												</span>
												<span>
													{formatRelative(session.createdAt)}创建
													{session.closedAt
														? ` · ${formatTime(session.closedAt)} 结束`
														: ""}
												</span>
											</div>
										</div>
										<div className="flex shrink-0 items-center gap-2">
											{openable && (
												<Button asChild size="sm" variant="outline">
													<Link to={`/remote-dev/${encodeURIComponent(session.sessionId)}`}>
														<Play className="size-3.5" aria-hidden="true" />
														打开
													</Link>
												</Button>
											)}
											{resumable && (
												<Button asChild size="sm">
													<Link
														to={`/remote-dev/new?resumeFrom=${encodeURIComponent(session.sessionId)}`}
													>
														<RotateCcw className="size-3.5" aria-hidden="true" />
														继续
													</Link>
												</Button>
											)}
											{!openable && !resumable && (
												<span className="flex items-center gap-1 text-xs text-muted-foreground">
													<ArrowRight className="size-3.5" aria-hidden="true" />
													已结束
												</span>
											)}
										</div>
									</li>
								);
							})}
						</ul>
					)}

					<div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-sm text-muted-foreground">
						<span>
							第 {page} / {totalPages} 页
						</span>
						<div className="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={page <= 1}
								onClick={() => setPage((current) => Math.max(1, current - 1))}
							>
								上一页
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={page >= totalPages}
								onClick={() => setPage((current) => current + 1)}
							>
								下一页
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
