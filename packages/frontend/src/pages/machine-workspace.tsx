import type { ClientInfo } from "@vcpdeck/shared";
import { useCallback } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeading } from "@/components/page-heading";
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
		<div className="space-y-6">
			<PageHeading
				title={client.hostname}
				description={`${client.os} · ${client.clientId}`}
				actions={<StatusChip label="在线" tone="success" />}
			/>
			<div className="flex flex-wrap gap-2">
				{capabilitiesLabel(client.capabilities).map((label) => (
					<StatusChip key={label} label={label} />
				))}
			</div>
			<nav
				aria-label="机器工作区"
				className="flex gap-5 overflow-x-auto border-b border-border/70"
			>
				{tabs.map(([key, label]) => (
					<NavLink
						key={key}
						to={`${base}/${key}`}
						className={({ isActive }) =>
							`min-h-11 border-b-2 px-1 py-3 text-sm ${isActive ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`
						}
					>
						{label}
					</NavLink>
				))}
			</nav>
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
		v != null ? (v * 100).toFixed(1) + "%" : "—";
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
