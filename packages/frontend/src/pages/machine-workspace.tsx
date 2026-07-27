import type { ClientInfo } from "@vcpdeck/shared";
import { useCallback } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";

const tabs = [
	["overview", "概览"], ["execute", "执行"], ["files", "文件"], ["frp", "FRP"], ["jobs", "任务记录"],
] as const;

export function MachineWorkspace() {
	const sdk = useSdk();
	const { clientId = "", tab } = useParams();
	const load = useCallback((signal: AbortSignal) => sdk.clients.list(signal), [sdk]);
	const resource = useResource(load);
	if (!tab) return <Navigate to={`/machines/${encodeURIComponent(clientId)}/overview`} replace />;
	if (resource.loading) return <LoadingState label="正在加载机器…" />;
	if (resource.error) return <ErrorState message="无法加载机器" onRetry={resource.reload} />;
	const client = resource.data?.find((item) => item.clientId === clientId);
	if (!client) return <Card><CardContent className="py-12 text-center"><h1 className="font-semibold">机器当前不在线</h1><p className="mt-2 text-sm text-muted-foreground">Server 不提供离线 Client 的历史详情。</p></CardContent></Card>;
	return <Workspace client={client} tab={tab} />;
}

function Workspace({ client, tab }: { client: ClientInfo; tab: string }) {
	const base = `/machines/${encodeURIComponent(client.clientId)}`;
	return (
		<div className="space-y-6">
			<PageHeading title={client.hostname} description={`${client.os} · ${client.clientId}`} actions={<StatusChip label="在线" tone="success" />} />
			<div className="flex flex-wrap gap-2">{client.capabilities.map((capability) => <StatusChip key={capability} label={capability} />)}</div>
			<nav aria-label="机器工作区" className="flex gap-5 overflow-x-auto border-b border-border/70">{tabs.map(([key, label]) => <NavLink key={key} to={`${base}/${key}`} className={({ isActive }) => `min-h-11 border-b-2 px-1 py-3 text-sm ${isActive ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>{label}</NavLink>)}</nav>
			{tab === "overview" ? <Card><CardContent className="pt-6 text-sm text-muted-foreground">该机器当前在线。选择标签页开始操作。</CardContent></Card> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">{tabs.find(([key]) => key === tab)?.[1] ?? "未知页面"}将在对应阶段接入。</CardContent></Card>}
		</div>
	);
}
