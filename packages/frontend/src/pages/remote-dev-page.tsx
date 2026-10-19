import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type {
	AgentPlacementInfo,
	ClientInfo,
	RemoteDevPortInfo,
	RemoteDevSessionInfo,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";
import { RemoteDevAgentPanel } from "./remote-dev-agent-panel";
import { RemoteDevFilesPanel } from "./remote-dev-files-panel";
import { RemoteDevPortsPanel } from "./remote-dev-ports-panel";
import {
	createRemoteDevSocket,
	type RemoteDevAttachment,
	type RemoteDevSocket,
} from "../remote-dev/remote-dev-socket.js";
import { TerminalPanel } from "./terminal-panel.js";

type Tab = "agent" | "terminal" | "files" | "ports";

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
			setError(typeof code === "string" ? code : "创建开发会话失败");
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
		return <LoadingState label="正在加载开发会话配置…" />;
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
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>新建开发会话</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{resumeSource && activeResumeFrom && (
						<div className="space-y-2 rounded-md border p-3 text-sm">
							<p>
								将续接会话 {resumeSource.sessionId} 的上下文
								{resumeSource.acpSessionId
									? `（ACP 会话 ${resumeSource.acpSessionId}）`
									: ""}
								：Client / Agent / Workspace 已按来源锁定。
							</p>
							<Button
								variant="ghost"
								onClick={() => navigate("/remote-dev/sessions")}
							>
								返回会话历史
							</Button>
						</div>
					)}
					{noClients ? (
						<div className="space-y-3">
							<p className="text-sm font-medium">还没有注册任何机器</p>
							<p className="text-sm text-muted-foreground">
								RDS 需要一台在线的目标 Client。先在「机器」页完成 Client 安装并等待注册，再回来创建开发会话。
							</p>
							<div className="flex flex-wrap gap-2">
								<Button onClick={() => navigate("/machines")}>去机器页</Button>
								<Button variant="outline" onClick={() => void load()}>
									刷新
								</Button>
							</div>
						</div>
					) : (
						<>
							<label className="block text-sm">
								<span className="mb-1 block text-muted-foreground">
									目标机器
								</span>
								<select
									className="w-full rounded-md border bg-background px-3 py-2"
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
							{visibleAgents.length === 0 ? (
								<div className="space-y-3 rounded-md border border-amber-400/60 bg-amber-50/40 p-3">
									<p className="text-sm font-medium">
										这台机器还没有登记 agent placement
									</p>
									<p className="text-sm text-muted-foreground">
										RDS 只使用 Server 登记表里的受控 placement，不会自动发现机器上已安装的 agent。请在 Server 侧登记逻辑 agentId、ACP 启动命令与 workspace roots。
									</p>
									<pre className="overflow-auto rounded-md bg-muted p-2 text-xs">
										<code>{agentCommand}</code>
									</pre>
									<div className="flex flex-wrap gap-2">
										<Button
											variant="outline"
											onClick={() => void copyText(agentCommand)}
										>
											复制命令
										</Button>
										<Button variant="outline" onClick={() => void load()}>
											刷新
										</Button>
										<Button
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
									<label className="block text-sm">
										<span className="mb-1 block text-muted-foreground">
											Agent
										</span>
										<select
											className="w-full rounded-md border bg-background px-3 py-2"
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
									<label
										className="block text-sm"
										htmlFor="remote-dev-workspace"
									>
										<span className="mb-1 block text-muted-foreground">
											Workspace（必须在机器 roots 内）
										</span>
										<Input
											id="remote-dev-workspace"
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
									<Button
										disabled={
											busy ||
											!clientId ||
											!agentPlacementId ||
											workspaceRoot.trim().length === 0
										}
										onClick={() => void create()}
									>
										{busy ? "正在启动…" : "创建开发会话"}
									</Button>
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
	const [tab, setTab] = useState<Tab>("agent");

	const reload = useCallback(async () => {
		try {
			const next = await sdk.remoteDev.get(sessionId);
			setSession(next);
			setPorts(await sdk.remoteDev.ports.list(sessionId));
			setError(null);
		} catch {
			setError("无法加载开发会话");
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
				if (!disposed) setError("无法附着开发会话");
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
			setError(`${payload.code}: ${payload.message}`),
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
			setError("关闭开发会话失败");
		}
	}, [sdk, sessionId, navigate]);

	if (!session) {
		return error ? (
			<ErrorState message={error} onRetry={() => void reload()} />
		) : (
			<LoadingState label="正在加载开发会话…" />
		);
	}

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader className="flex flex-row items-start justify-between gap-4">
					<div>
						<CardTitle>开发会话</CardTitle>
						<p className="mt-1 text-sm text-muted-foreground">
							{session.clientId} · {session.workspaceRoot} · {session.state}
							{attachment ? ` · ${attachment.mode}` : ""}
						</p>
					</div>
					<Button variant="outline" onClick={() => void close()}>
						关闭
					</Button>
				</CardHeader>
				<CardContent>
					{error && <p className="mb-2 text-sm text-destructive">{error}</p>}
					<div className="flex flex-wrap gap-2">
						{(["agent", "terminal", "files", "ports"] as const).map((item) => (
							<Button
								key={item}
								variant={tab === item ? "default" : "outline"}
								onClick={() => setTab(item)}
							>
								{item}
							</Button>
						))}
					</div>
				</CardContent>
			</Card>
			{tab === "agent" && (
				<RemoteDevAgentPanel
					session={session}
					socket={socket}
					mode={attachment?.mode ?? "viewer"}
				/>
			)}
			{tab === "terminal" && (
				<TerminalPanel
					clientId={session.clientId}
					parentRemoteDevSessionId={session.sessionId}
				/>
			)}
			{tab === "files" && (
				<RemoteDevFilesPanel
					clientId={session.clientId}
					workspaceRoot={session.workspaceRoot}
				/>
			)}
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
