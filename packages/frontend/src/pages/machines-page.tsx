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
		<Card className="overflow-hidden transition-shadow hover:shadow-2xl">
			<CardHeader className="pb-4">
				<div className="flex items-start gap-4">
					<div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
						<OperatingSystemIcon os={client.os} />
					</div>
					<div className="min-w-0 flex-1">
						<CardTitle className="truncate">
							<Link
								className="rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								to={`${base}/overview`}
							>
								{client.hostname}
							</Link>
						</CardTitle>
						<p className="mt-1 truncate font-mono text-xs text-muted-foreground">
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
				<div className="mt-5 flex flex-wrap gap-3 border-t border-border/60 pt-4 text-sm">
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

function OperatingSystemIcon({ os }: { os: string }) {
	const normalized = os.toLowerCase();
	if (normalized.includes("darwin") || normalized.includes("mac"))
		return <MacOsIcon />;
	if (normalized.includes("win")) return <WindowsIcon />;
	return <LinuxIcon />;
}

function WindowsIcon() {
	return (
		<svg
			role="img"
			aria-label="Windows"
			viewBox="0 0 24 24"
			className="size-7"
			fill="currentColor"
		>
			<path d="M3 5.1 10.7 4v7.3H3V5.1Zm8.8-1.25L21 2.5v8.8h-9.2V3.85ZM3 12.7h7.7V20L3 18.9v-6.2Zm8.8 0H21v8.8l-9.2-1.35V12.7Z" />
		</svg>
	);
}

function LinuxIcon() {
	return (
		<svg
			role="img"
			aria-label="Linux"
			viewBox="0 0 24 24"
			className="size-7"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M8.2 10.2C8.4 6.1 9.7 3 12 3s3.6 3.1 3.8 7.2c1.7 1.8 2.7 4.4 2.2 6.7-.4 2-1.7 3.4-3.5 3.1a6.4 6.4 0 0 1-5 0c-1.8.3-3.1-1.1-3.5-3.1-.5-2.3.5-4.9 2.2-6.7Z" />
			<circle cx="10.2" cy="8.2" r=".7" fill="currentColor" stroke="none" />
			<circle cx="13.8" cy="8.2" r=".7" fill="currentColor" stroke="none" />
			<path d="m10.2 10.2 1.8 1 1.8-1M9.4 19.8 7 21M14.6 19.8 17 21" />
		</svg>
	);
}

function MacOsIcon() {
	return (
		<svg
			role="img"
			aria-label="macOS"
			viewBox="0 0 24 24"
			className="size-7"
			fill="currentColor"
		>
			<path d="M15.6 3c.1 1.1-.4 2.2-1.1 3-.8.8-1.9 1.3-3 1.2-.1-1.1.4-2.2 1.1-2.9.8-.8 2-1.3 3-1.3Zm3.9 13.4c-.5 1.2-1.1 2.3-1.9 3.4-.7 1-1.5 2.1-2.8 2.1-1.1 0-1.5-.7-2.8-.7-1.4 0-1.8.7-2.9.7-1.2 0-2.1-1.1-2.8-2.1C4.2 16.9 4 13.5 5.4 11.3A4.6 4.6 0 0 1 9.3 9c1.2 0 2.3.8 3 .8.7 0 2-.9 3.4-.8.6 0 2.5.2 3.7 2-2.9 1.7-2.4 5.4.1 6.4Z" />
		</svg>
	);
}
