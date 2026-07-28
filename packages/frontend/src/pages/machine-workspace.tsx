import type { ClientInfo } from "@vcpdeck/shared";
import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Card, CardContent } from "@/components/ui/card";
import { StatusChip } from "@/components/status-chip";
import { capabilitiesLabel } from "@/lib/utils";
import { ExecutePanel } from "@/pages/execute-panel";
import { FilesPanel } from "@/pages/files-panel";
import { FrpPanel } from "@/pages/frp-panel";
import { JobsPage } from "@/pages/jobs-page";

const tabs = [
	["overview", "概览"],
	["execute", "执行"],
	["files", "文件"],
	["frp", "FRP"],
	["jobs", "任务记录"],
] as const;

export function MachineWorkspace() {
	const sdk = useSdk();
	const { clientId = "", tab } = useParams();
	const load = useCallback(
		(signal: AbortSignal) => sdk.clients.list(signal),
		[sdk],
	);
	const resource = useResource(load);
	const { reload } = resource;
	// 每 10 秒自动刷新机器信息（服务端心跳每 5 秒更新）
	useEffect(() => {
		const timer = setInterval(reload, 10000);
		return () => clearInterval(timer);
	}, [reload]);
	if (!tab)
		return (
			<Navigate
				to={`/machines/${encodeURIComponent(clientId)}/overview`}
				replace
			/>
		);
	if (resource.loading) return <LoadingState label="正在加载机器…" />;
	if (resource.error)
		return <ErrorState message="无法加载机器" onRetry={resource.reload} />;
	const client = resource.data?.find((item) => item.clientId === clientId);
	if (!client)
		return (
			<Card>
				<CardContent className="py-12 text-center">
					<h1 className="font-semibold">机器当前不在线</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						Server 不提供离线 Client 的历史详情。
					</p>
				</CardContent>
			</Card>
		);
	return <Workspace client={client} tab={tab} />;
}

function Workspace({ client, tab }: { client: ClientInfo; tab: string }) {
	const base = `/machines/${encodeURIComponent(client.clientId)}`;
	return (
		<div className="space-y-4">
			<header
				data-testid="machine-workspace-header"
				className="space-y-3 border-b border-border/70 pb-0"
			>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h1 className="truncate text-xl font-semibold tracking-tight">
								{client.hostname}
							</h1>
							<StatusChip label="在线" tone="success" />
						</div>
						<p className="truncate text-xs text-muted-foreground">
							{client.os} · {client.clientId}
						</p>
					</div>
					<div className="ml-auto flex flex-wrap items-center gap-1.5">
						{capabilitiesLabel(client.capabilities).map((label) => (
							<StatusChip key={label} label={label} />
						))}
					</div>
				</div>
				<div className="flex items-end gap-2">
					<nav
						aria-label="机器工作区"
						className="flex min-w-0 flex-1 gap-5 overflow-x-auto"
					>
						{tabs.map(([key, label]) => (
							<NavLink
								key={key}
								to={`${base}/${key}`}
								className={({ isActive }) =>
									`shrink-0 border-b-2 px-1 pb-2 text-sm ${isActive ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`
								}
							>
								{label}
							</NavLink>
						))}
					</nav>
					{tab === "files" && (
						<div className="group relative mb-2 shrink-0">
							<button
								type="button"
								aria-label="文件操作安全提示"
								aria-describedby="file-risk-tooltip"
								className="flex size-7 items-center justify-center rounded-md text-amber-500 hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<TriangleAlert className="size-4" />
							</button>
							<div
								id="file-risk-tooltip"
								role="tooltip"
								className="pointer-events-none absolute bottom-full right-0 z-30 mb-2 w-72 rounded-lg border border-amber-500/30 bg-background px-3 py-2 text-xs text-foreground opacity-0 shadow-xl transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
							>
								文件能力仅面向可信操作者；当前 Client 的 symlink
								边界仍有已知风险。
							</div>
						</div>
					)}
				</div>
			</header>
			{tab === "overview" && <Overview client={client} />}
			{tab === "execute" && <ExecutePanel clientId={client.clientId} />}
			{tab === "files" && <FilesPanel clientId={client.clientId} />}
			{tab === "frp" && <FrpPanel clientId={client.clientId} />}
			{tab === "jobs" && <JobsPage clientId={client.clientId} />}
			{!["overview", "execute", "files", "frp", "jobs"].includes(tab) && (
				<Card>
					<CardContent className="pt-6 text-sm text-muted-foreground">
						{tabs.find(([key]) => key === tab)?.[1] ?? "未知页面"}
						将在对应阶段接入。
					</CardContent>
				</Card>
			)}
		</div>
	);
}

function Overview({ client }: { client: ClientInfo }) {
	const pct = (v: number | null | undefined) =>
		v != null ? v.toFixed(1) + "%" : "—";
	const fmt = (v: number | undefined) => {
		if (v == null) return "—";
		return v >= 1_000_000
			? (v / 1_000_000).toFixed(1) + " TB"
			: v >= 1_000
				? (v / 1_000).toFixed(0) + " GB"
				: v + " MB";
	};
	return (
		<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
			<Card>
				<CardContent className="pt-6">
					<p className="text-sm text-muted-foreground">CPU</p>
					<p className="mt-1 text-sm font-medium">{client.cpuModel}</p>
					<p className="text-xs text-muted-foreground">
						使用率 {pct(client.cpuPercent)}
					</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-6">
					<p className="text-sm text-muted-foreground">内存</p>
					<p className="mt-1 text-sm font-medium">{fmt(client.totalMemMB)}</p>
					<p className="text-xs text-muted-foreground">
						使用率 {pct(client.memPercent)}
					</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-6">
					<p className="text-sm text-muted-foreground">磁盘</p>
					<p className="mt-1 text-sm font-medium">{fmt(client.totalDiskMB)}</p>
					<p className="text-xs text-muted-foreground">
						使用率 {pct(client.diskPercent)}
					</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-6">
					<p className="text-sm text-muted-foreground">版本</p>
					<p className="mt-1 text-sm font-medium">{client.clientVersion}</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-6">
					<p className="text-sm text-muted-foreground">操作系统</p>
					<p className="mt-1 text-sm font-medium">{client.os}</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-6">
					<p className="text-sm text-muted-foreground">最后心跳</p>
					<p className="mt-1 text-sm font-medium">
						{client.lastHeartbeatAt
							? new Date(client.lastHeartbeatAt).toLocaleString()
							: "未知"}
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
