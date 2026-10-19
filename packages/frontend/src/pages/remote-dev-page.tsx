import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
	Bot,
	Copy,
	FolderGit2,
	Monitor,
	Plug,
	type LucideIcon,
} from "lucide-react";
import type {
	AgentPlacementInfo,
	ClientInfo,
	RemoteDevPortInfo,
	RemoteDevSessionInfo,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";
import {
	agentStateBadge,
	attachModeLabel,
	cleanupLabel,
	describeRemoteDevError,
	formatRelative,
	isTerminalState,
	sessionStateBadge,
} from "../remote-dev/presentation.js";
import { RemoteDevPortsPanel } from "./remote-dev-ports-panel";
import { RemoteDevTranscript } from "./remote-dev-transcript";
import {
	createRemoteDevSocket,
	type RemoteDevAttachment,
	type RemoteDevSocket,
} from "../remote-dev/remote-dev-socket.js";

type Tab = "transcript" | "ports";

/** 运行详情页视图切换：没有输入框，只有「跑过什么」和「开了哪些端口」。 */
const TABS: readonly { value: Tab; label: string; icon: LucideIcon }[] = [
	{ value: "transcript", label: "运行记录", icon: Bot },
	{ value: "ports", label: "端口", icon: Plug },
];

function reconnectTokenKey(sessionId: string): string {
	return `vcpdev:rds:reconnect:${sessionId}`;
}

function readReconnectToken(sessionId: string): string | undefined {
	try {
		return window.sessionStorage.getItem(reconnectTokenKey(sessionId)) ?? undefined;
	} catch {
		return undefined;
	}
}

function saveReconnectToken(sessionId: string, token: string): void {
	try {
		window.sessionStorage.setItem(reconnectTokenKey(sessionId), token);
	} catch {
		/* 隐私模式等存储不可用时，仅本次连接有效。 */
	}
}

function clearReconnectToken(sessionId: string): void {
	try {
		window.sessionStorage.removeItem(reconnectTokenKey(sessionId));
	} catch {
		/* 忽略存储不可用。 */
	}
}

export function RemoteDevPage() {
	const { sessionId } = useParams();
	return sessionId ? (
		<RemoteDevSessionPage sessionId={sessionId} />
	) : (
		<RemoteDevCreatePage />
	);
}

function RemoteDevCreatePage() {
	const sdk = useSdk();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	/** 续接来源会话 id（`?resumeFrom=`）；非空时复用它的 ACP 上下文。 */
	const resumeFrom = searchParams.get("resumeFrom") ?? "";
	/**
	 * 实际生效的续接来源。
	 *
	 * 与 URL 分开：来源读不出来时清空它，提交就退回"新建会话"，
	 * 而不是拿一个已知读不到的 id 去换一个裸错误码。
	 */
	const [activeResumeFrom, setActiveResumeFrom] = useState(resumeFrom);
	const [resumeSource, setResumeSource] =
		useState<RemoteDevSessionInfo | null>(null);
	const [clients, setClients] = useState<ClientInfo[] | null>(null);
	const [agents, setAgents] = useState<AgentPlacementInfo[] | null>(null);
	const [clientId, setClientId] = useState("");
	const [agentPlacementId, setAgentPlacementId] = useState("");
	const [workspaceRoot, setWorkspaceRoot] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const [clientList, agentPage] = await Promise.all([
					sdk.clients.list(signal),
					sdk.agents.list({ pageSize: 100 }, signal),
				]);
				if (signal?.aborted) return;
				setClients(clientList);
				setAgents(agentPage.data);
				// 先落默认选择，保证表单在任何分支都可渲染；续接成功再覆盖
				const firstClientId = clientList[0]?.clientId ?? "";
				const firstAgent =
					agentPage.data.find(
						(agent) => agent.clientId === firstClientId && agent.enabled,
					) ?? agentPage.data[0];
				setClientId(firstClientId);
				setAgentPlacementId(firstAgent?.id ?? "");
				setWorkspaceRoot(firstAgent?.workspaceRoots[0] ?? "");
				setResumeSource(null);
				setError(null);
				setActiveResumeFrom("");
				if (!resumeFrom) return;
				// 续接：Client / Agent / Workspace 必须与来源一致，服务端还会再校验一次
				try {
					const source = await sdk.remoteDev.get(resumeFrom, signal);
					if (signal?.aborted) return;
					setResumeSource(source);
					setClientId(source.clientId);
					setAgentPlacementId(source.agentPlacementId);
					setWorkspaceRoot(source.workspaceRoot);
					setActiveResumeFrom(resumeFrom);
				} catch {
					if (!signal?.aborted) {
						setError("无法读取要续接的会话，已按新建会话处理");
					}
				}
			} catch {
				if (!signal?.aborted) setError("无法加载机器或 agent");
			}
		},
		[sdk, resumeFrom],
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const create = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const session = await sdk.remoteDev.create({
				clientId,
				agentPlacementId,
				workspaceRoot,
				...(activeResumeFrom ? { resumeFromSessionId: activeResumeFrom } : {}),
			});
			navigate(`/remote-dev/${encodeURIComponent(session.sessionId)}`);
		} catch (cause) {
			const code = (cause as { code?: unknown }).code;
			setError(typeof code === "string" ? code : "创建自动化任务失败");
		} finally {
			setBusy(false);
		}
	}, [
		sdk,
		clientId,
		agentPlacementId,
		workspaceRoot,
		activeResumeFrom,
		navigate,
	]);

	if (error && clients === null) {
		return <ErrorState message={error} />;
	}
	if (clients === null || agents === null) {
		return <LoadingState label="正在加载自动化任务配置…" />;
	}
	const visibleAgents = clientId
		? agents.filter((agent) => agent.clientId === clientId && agent.enabled)
		: [];
	const noClients = clients.length === 0;
	const agentCommand = [
		"vcpdeck agents create",
		`--client=${clientId || "<clientId>"}`,
		"--agent=<agentId>",
		"--name=<显示名>",
		"--command=<启动命令>",
		"--arg=<参数>",
		"--workspace-root=<workspace 根目录>",
	].join(" ");
	return (
		<div className="mx-auto max-w-3xl space-y-4">
			<PageHeading
				title="新建自动化任务"
				description="无人值守通道：选机器与已登记的 agent，跑一轮可脚本驱动、可审计的任务。需要人机结对改代码，请去「开发」里的远程 DSH。"
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() => navigate("/remote-dev/sessions")}
					>
						会话历史
					</Button>
				}
			/>

			{resumeSource && activeResumeFrom && (
				<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
					<div className="min-w-0">
						<p className="font-medium">将续接会话 {resumeSource.sessionId} 的上下文</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							机器、agent 与 workspace 已按来源会话锁定
							{resumeSource.acpSessionId
								? `；会复用 ACP 会话 ${resumeSource.acpSessionId}`
								: ""}
						</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="shrink-0"
						onClick={() => navigate("/remote-dev/sessions")}
					>
						返回会话历史
					</Button>
				</div>
			)}

			<Card>
				<CardContent className="space-y-5 pt-6">
					{noClients ? (
						<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-10 text-center">
							<Monitor className="size-7 text-muted-foreground" aria-hidden="true" />
							<div className="space-y-1">
								<p className="text-sm font-medium">还没有注册任何机器</p>
								<p className="max-w-md text-sm text-muted-foreground">
									自动化任务需要一台在线的目标机器。先在「机器」页完成客户端安装并等待注册，再回来创建。
								</p>
							</div>
							<div className="flex flex-wrap justify-center gap-2">
								<Button onClick={() => navigate("/machines")}>去机器页</Button>
								<Button variant="outline" onClick={() => void load()}>
									刷新
								</Button>
							</div>
						</div>
					) : (
						<>
							<div className="grid gap-4 sm:grid-cols-2">
								<label className="block text-sm">
									<span className="mb-1.5 block font-medium text-muted-foreground">
										目标机器
									</span>
									<select
										className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
										disabled={activeResumeFrom !== ""}
										value={clientId}
										onChange={(event) => {
											const next = event.target.value;
											setClientId(next);
											const first = agents.find(
												(agent) => agent.clientId === next && agent.enabled,
											);
											setAgentPlacementId(first?.id ?? "");
											setWorkspaceRoot(first?.workspaceRoots[0] ?? "");
										}}
									>
										{clients.map((client) => (
											<option key={client.clientId} value={client.clientId}>
												{client.name} ({client.hostname})
											</option>
										))}
									</select>
								</label>
								{visibleAgents.length > 0 && (
									<label className="block text-sm">
										<span className="mb-1.5 block font-medium text-muted-foreground">
											Agent
										</span>
										<select
											className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
											disabled={activeResumeFrom !== ""}
											value={agentPlacementId}
											onChange={(event) => {
												const next = event.target.value;
												setAgentPlacementId(next);
												const agent = agents.find((item) => item.id === next);
												setWorkspaceRoot(agent?.workspaceRoots[0] ?? "");
											}}
										>
											{visibleAgents.map((agent) => (
												<option key={agent.id} value={agent.id}>
													{agent.agentId} — {agent.name}
												</option>
											))}
										</select>
									</label>
								)}
							</div>

							{clients.find((client) => client.clientId === clientId)?.dshWebUrl && (
								<p className="text-xs text-amber-500/90">
									这台机器已登记远程 DSH：同一会话不要同时被 RDS 与 DSH 界面驱动（单写者，ADR-0059）。
								</p>
							)}
							{visibleAgents.length === 0 ? (
								<div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
									<div className="space-y-1">
										<p className="text-sm font-medium">
											这台机器还没有登记 agent placement
										</p>
										<p className="text-sm text-muted-foreground">
											自动化任务只使用 Server 登记表里的受控 placement，不会自动发现机器上装了哪些 agent。请在 Server 侧登记 agentId、ACP 启动命令与 workspace roots。
										</p>
									</div>
									<pre className="overflow-x-auto rounded-lg bg-background/60 p-3 text-xs">
										<code>{agentCommand}</code>
									</pre>
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="outline"
											onClick={() => void copyText(agentCommand)}
										>
											复制命令
										</Button>
										<Button size="sm" variant="outline" onClick={() => void load()}>
											刷新
										</Button>
										<Button
											size="sm"
											variant="ghost"
											onClick={() => navigate("/machines")}
										>
											查看机器
										</Button>
									</div>
									<p className="text-xs text-muted-foreground">
										也可以直接调用 <code>POST /api/agents</code>
										；字段语义见 docs/domain-model.md。
									</p>
								</div>
							) : (
								<>
									<label
										className="block text-sm"
										htmlFor="remote-dev-workspace"
									>
										<span className="mb-1.5 block font-medium text-muted-foreground">
											Workspace（必须在机器 roots 内）
										</span>
										<Input
											id="remote-dev-workspace"
											className="font-mono"
											disabled={activeResumeFrom !== ""}
											value={workspaceRoot}
											onChange={(event) =>
												setWorkspaceRoot(event.target.value)
											}
										/>
									</label>
									{error && (
										<p className="text-sm text-destructive">{error}</p>
									)}
									<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
										<p className="text-xs text-muted-foreground">
											agent 会在该目录启动；会话结束后可在「会话历史」里继续。
										</p>
										<Button
											className="shrink-0"
											disabled={
												busy ||
												!clientId ||
												!agentPlacementId ||
												workspaceRoot.trim().length === 0
											}
											onClick={() => void create()}
										>
											{busy ? "正在启动…" : "创建任务"}
										</Button>
									</div>
								</>
							)}
						</>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function RemoteDevSessionPage({ sessionId }: { sessionId: string }) {
	const sdk = useSdk();
	const navigate = useNavigate();
	const [session, setSession] = useState<RemoteDevSessionInfo | null>(null);
	const [ports, setPorts] = useState<RemoteDevPortInfo[]>([]);
	const [attachment, setAttachment] = useState<RemoteDevAttachment | null>(null);
	const [socket] = useState<RemoteDevSocket>(() => createRemoteDevSocket());
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("transcript");
	const [clientName, setClientName] = useState("");
	const [agentName, setAgentName] = useState("");
	const [copied, setCopied] = useState(false);

	const reload = useCallback(async () => {
		try {
			const next = await sdk.remoteDev.get(sessionId);
			setSession(next);
			setPorts(await sdk.remoteDev.ports.list(sessionId));
			setError(null);
			// 名称只是展示增强：取不到就退回原始 id，不能因此挡住会话本身
			try {
				const [clients, agents] = await Promise.all([
					sdk.clients.list(),
					sdk.agents.list({ pageSize: 100 }),
				]);
				setClientName(
					clients.find((client) => client.clientId === next.clientId)?.name ??
						next.clientId,
				);
				const placement = agents.data.find(
					(item) => item.id === next.agentPlacementId,
				);
				setAgentName(
					placement ? `${placement.name}（${placement.agentId}）` : next.agentPlacementId,
				);
			} catch {
				setClientName(next.clientId);
				setAgentName(next.agentPlacementId);
			}
		} catch {
			setError("无法加载运行记录");
		}
	}, [sdk, sessionId]);

	useEffect(() => {
		void reload();
		let disposed = false;
		let attachedOnce = false;
		const attach = async () => {
			try {
				const next = await socket.attach(
					sessionId,
					readReconnectToken(sessionId),
				);
				if (disposed) return;
				setAttachment(next);
				if (next.mode === "operator" && next.reconnectToken) {
					saveReconnectToken(sessionId, next.reconnectToken);
				}
			} catch {
				if (!disposed) setError("无法附着运行记录");
			}
		};
		const offState = socket.onState((payload) => {
			setSession(payload.session);
			setPorts(payload.ports);
			if (payload.attachment) setAttachment(payload.attachment);
		});
		const offPort = socket.onPortState((port) => {
			setPorts((current) => {
				const rest = current.filter((item) => item.portId !== port.portId);
				return [...rest, port];
			});
		});
		const offClosed = socket.onClosed(() => {
			clearReconnectToken(sessionId);
			void reload();
		});
		const offError = socket.onError((payload) =>
			setError(describeRemoteDevError(payload.code)),
		);
		const offAgentStatus = socket.onAgentEvent((event) => {
			if (event.type !== "agent.status") return;
			setSession((current) =>
				current ? { ...current, agentStatus: event.status } : current,
			);
		});
		const offConnection = socket.onConnectionChange((connected) => {
			if (connected && attachedOnce) void attach();
		});
		void attach().finally(() => {
			attachedOnce = true;
		});
		return () => {
			disposed = true;
			offState();
			offPort();
			offClosed();
			offError();
			offAgentStatus();
			offConnection();
			void socket.detach(sessionId).catch(() => undefined);
			socket.dispose();
		};
	}, [socket, sessionId, reload]);

	const close = useCallback(async () => {
		try {
			await sdk.remoteDev.close(sessionId);
			clearReconnectToken(sessionId);
			navigate("/remote-dev");
		} catch {
			setError("关闭运行失败");
		}
	}, [sdk, sessionId, navigate]);

	if (!session) {
		return error ? (
			<ErrorState message={error} onRetry={() => void reload()} />
		) : (
			<LoadingState label="正在加载运行记录…" />
		);
	}

	const state = sessionStateBadge(session.state);
	const agent = agentStateBadge(session.agentStatus);
	// 清理状态只在会话已结束时有意义；运行中挂一条"待确认"是噪音
	const cleanup = isTerminalState(session.state)
		? cleanupLabel(session.cleanupStatus)
		: null;

	return (
		<div className="space-y-4">
			<header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="text-xl font-semibold tracking-tight">自动化运行</h1>
						<StatusChip label={state.label} tone={state.tone} />
						<StatusChip label={`agent ${agent.label}`} tone={agent.tone} />
						{attachment && (
							<StatusChip
								label={attachModeLabel(attachment.mode)}
								tone="neutral"
							/>
						)}
						{cleanup && <StatusChip label={cleanup} tone="warning" />}
					</div>
					<ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
						<li className="flex items-center gap-1.5">
							<Monitor className="size-3.5" aria-hidden="true" />
							{clientName || session.clientId}
						</li>
						<li className="flex items-center gap-1.5">
							<Bot className="size-3.5" aria-hidden="true" />
							{agentName || session.agentPlacementId}
						</li>
						<li className="flex items-center gap-1.5 font-mono text-xs">
							<FolderGit2 className="size-3.5" aria-hidden="true" />
							<span className="max-w-[28rem] truncate" title={session.workspaceRoot}>
								{session.workspaceRoot}
							</span>
						</li>
						<li>{formatRelative(session.createdAt)}创建</li>
					</ul>
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							void copyText(session.sessionId).then(() => {
								setCopied(true);
								window.setTimeout(() => setCopied(false), 1500);
							});
						}}
					>
						<Copy className="size-3.5" aria-hidden="true" />
						{copied ? "已复制" : "复制 ID"}
					</Button>
					<Button variant="outline" size="sm" onClick={() => void close()}>
						停止并结束
					</Button>
				</div>
			</header>

			{error && (
				<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{error}
				</div>
			)}

			<Card>
				<div
					aria-label="运行详情视图"
					className="flex gap-1 overflow-x-auto border-b border-border/70 px-2"
					role="tablist"
				>
					{TABS.map(({ value, label, icon: Icon }) => (
						<button
							type="button"
							key={value}
							aria-selected={tab === value}
							className={`flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm transition ${
								tab === value
									? "border-primary text-primary"
									: "border-transparent text-muted-foreground hover:text-foreground"
							}`}
							onClick={() => setTab(value)}
							role="tab"
						>
							<Icon className="size-4" aria-hidden="true" />
							{label}
						</button>
					))}
				</div>
			</Card>

			{/* 运行记录保持挂载：切到端口再回来时不能丢已接收的实时事件 */}
			<div className={tab === "transcript" ? "block" : "hidden"}>
				<RemoteDevTranscript session={session} socket={socket} />
			</div>
			{tab === "ports" && (
				<RemoteDevPortsPanel
					session={session}
					ports={ports}
					socket={socket}
					mode={attachment?.mode ?? "viewer"}
				/>
			)}
		</div>
	);
}
