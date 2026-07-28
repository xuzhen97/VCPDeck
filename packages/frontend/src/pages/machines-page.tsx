import type { ClientInfo } from "@vcpdeck/shared";
import { ArrowRight, FolderOpen, TerminalSquare } from "lucide-react";
import { useCallback } from "react";
import { Link } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
import { capabilitiesLabel } from "@/lib/utils";

export function MachinesPage() {
	const sdk = useSdk();
	const load = useCallback(
		(signal: AbortSignal) => sdk.clients.list(signal),
		[sdk],
	);
	const resource = useResource(load);

	if (resource.loading) return <LoadingState label="正在加载在线机器…" />;
	if (resource.error)
		return <ErrorState message="无法加载在线机器" onRetry={resource.reload} />;

	const clients = resource.data ?? [];
	return (
		<div className="space-y-6">
			<PageHeading
				title="机器"
				description="当前连接到 Server 的在线 Client。"
				actions={
					resource.refreshing ? (
						<span className="text-sm text-muted-foreground">正在刷新…</span>
					) : undefined
				}
			/>
			{clients.length === 0 ? (
				<Card>
					<CardContent className="py-12 text-center">
						<h2 className="font-semibold">当前没有在线机器</h2>
						<p className="mt-2 text-sm text-muted-foreground">
							Server 只提供在线 Client，离线历史不会显示在此处。
						</p>
					</CardContent>
				</Card>
			) : (
				<div className="grid gap-4 xl:grid-cols-2">
					{clients.map((client) => (
						<MachineCard key={client.clientId} client={client} />
					))}
				</div>
			)}
		</div>
	);
}

function MachineCard({ client }: { client: ClientInfo }) {
	const base = `/machines/${encodeURIComponent(client.clientId)}`;
	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-4">
					<div>
						<CardTitle>{client.hostname}</CardTitle>
						<p className="mt-1 font-mono text-xs text-muted-foreground">
							{client.clientId}
						</p>
					</div>
					<StatusChip label="在线" tone="success" />
				</div>
			</CardHeader>
			<CardContent>
				<p className="text-sm text-muted-foreground">
					{client.os} · 心跳{" "}
					{client.lastHeartbeatAt
						? new Date(client.lastHeartbeatAt).toLocaleString()
						: "未知"}
				</p>
				<div className="mt-4 flex flex-wrap gap-2">
					{capabilitiesLabel(client.capabilities).map((item) => (
						<StatusChip key={item} label={item} />
					))}
				</div>
				<div className="mt-6 flex flex-wrap gap-3 text-sm">
					<Link
						className="inline-flex items-center gap-1 text-primary"
						to={`${base}/execute`}
					>
						<TerminalSquare className="size-4" />
						执行
					</Link>
					<Link
						className="inline-flex items-center gap-1 text-primary"
						to={`${base}/files`}
					>
						<FolderOpen className="size-4" />
						文件
					</Link>
					<Link
						className="inline-flex items-center gap-1 text-primary"
						to={`${base}/frp`}
					>
						FRP
						<ArrowRight className="size-4" />
					</Link>
				</div>
			</CardContent>
		</Card>
	);
}
