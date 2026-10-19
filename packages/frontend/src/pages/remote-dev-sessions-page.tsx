import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
	REMOTE_DEV_TERMINAL_STATES,
	type ClientInfo,
	type RemoteDevSessionInfo,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** 与 Server 共用同一份终态集合：只有终态且带 ACP 上下文时才可续接。 */
const RESUMABLE_STATES: readonly string[] = REMOTE_DEV_TERMINAL_STATES;

/** 仍在运行、可以直接进去的状态。 */
const OPENABLE_STATES = ["starting", "active", "detached"];

const STATE_OPTIONS = [
	{ value: "", label: "全部状态" },
	{ value: "active", label: "active" },
	{ value: "detached", label: "detached" },
	{ value: "closed", label: "closed" },
	{ value: "failed", label: "failed" },
	{ value: "interrupted", label: "interrupted" },
];

function formatTime(value?: string): string {
	if (!value) return "—";
	const at = new Date(value);
	return Number.isNaN(at.getTime()) ? "—" : at.toLocaleString();
}

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

	return (
		<Card>
			<CardHeader>
				<CardTitle>开发会话</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex flex-wrap items-end gap-3">
					<label className="text-sm">
						<span className="mb-1 block text-muted-foreground">机器</span>
						<select
							className="rounded-md border bg-background px-3 py-2"
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
						<span className="mb-1 block text-muted-foreground">状态</span>
						<select
							className="rounded-md border bg-background px-3 py-2"
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
					<Button variant="outline" onClick={() => void load()}>
						刷新
					</Button>
					<Button onClick={() => navigate("/remote-dev/new")}>新建会话</Button>
				</div>

				{error && <p className="text-sm text-destructive">{error}</p>}

				{sessions.length === 0 ? (
					<div className="space-y-2 rounded-md border p-4 text-sm text-muted-foreground">
						<p>还没有开发会话，先创建一条。</p>
						<p className="text-xs">
							会话结束后仍可从本页「继续」——那会复用原 ACP 会话的上下文。
						</p>
					</div>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="text-left text-muted-foreground">
								<tr>
									<th className="py-2 pr-4">会话</th>
									<th className="py-2 pr-4">机器</th>
									<th className="py-2 pr-4">Workspace</th>
									<th className="py-2 pr-4">状态</th>
									<th className="py-2 pr-4">agent</th>
									<th className="py-2 pr-4">创建</th>
									<th className="py-2 pr-4">结束</th>
									<th className="py-2">操作</th>
								</tr>
							</thead>
							<tbody>
								{sessions.map((session) => {
									const resumable =
										session.acpSessionId !== undefined &&
										RESUMABLE_STATES.includes(session.state);
									const openable = OPENABLE_STATES.includes(session.state);
									return (
										<tr key={session.sessionId} className="border-t">
											<td className="py-2 pr-4 font-mono text-xs">
												{session.sessionId}
											</td>
											<td className="py-2 pr-4">
												{clientName(session.clientId)}
											</td>
											<td className="py-2 pr-4 font-mono text-xs">
												{session.workspaceRoot}
											</td>
											<td className="py-2 pr-4">
												{session.state}
												{session.cleanupStatus !== "complete" &&
													session.state === "closed" && (
														<span className="ml-1 text-xs text-muted-foreground">
															(清理 {session.cleanupStatus})
														</span>
													)}
											</td>
											<td className="py-2 pr-4">{session.agentStatus}</td>
											<td className="py-2 pr-4">{formatTime(session.createdAt)}</td>
											<td className="py-2 pr-4">{formatTime(session.closedAt)}</td>
											<td className="py-2">
												<div className="flex gap-2">
													{openable && (
														<Link
															className="underline"
															to={`/remote-dev/${encodeURIComponent(session.sessionId)}`}
														>
															打开
														</Link>
													)}
													{resumable && (
														<Link
															className="underline"
															to={`/remote-dev/new?resumeFrom=${encodeURIComponent(session.sessionId)}`}
														>
															继续
														</Link>
													)}
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}

				<div className="flex items-center gap-3 text-sm text-muted-foreground">
					<span>
						共 {total} 条，第 {page} / {totalPages} 页
					</span>
					<Button
						variant="outline"
						disabled={page <= 1}
						onClick={() => setPage((current) => Math.max(1, current - 1))}
					>
						上一页
					</Button>
					<Button
						variant="outline"
						disabled={page >= totalPages}
						onClick={() => setPage((current) => current + 1)}
					>
						下一页
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
