import type { ClientInfo } from "@vcpdeck/shared";
import {
	BrainCircuit,
	FolderOpen,
	History,
	LayoutDashboard,
	Network,
	SquareTerminal,
	TerminalSquare,
	type LucideIcon,
} from "lucide-react";
import { useCallback } from "react";
import { Link } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { OperatingSystemIcon } from "@/components/operating-system-icon";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
import { MACHINE_TABS, capabilitiesLabel } from "@/lib/utils";

/**
 * 非交互特权能力展示（ADR-0023）：
 * sudo-all → root 等价风险；unavailable → 无 root 等价；缺省 → 未报告（不推断）。
 */
function privilegedLabel(client: ClientInfo): string {
	const p = client.capabilityDetails?.privileged;
	if (!p) return "特权未报告";
	if (p.available && p.mode === "sudo-all" && p.nonInteractive) return "root 等价特权";
	return "root 等价特权不可用";
}

/** 安装模式展示：systemd-root-equivalent → 系统级；legacy-pm2 → 旧版 PM2；缺省 → 未报告。 */
function installationLabel(client: ClientInfo): string {
	const m = client.installation?.mode;
	if (m === "systemd-root-equivalent") return "系统级部署";
	if (m === "legacy-pm2") return "旧版 PM2";
	return "安装模式未报告";
}

/** 详情页 tab → 卡片快捷跳转图标 */
const tabIcons: Record<string, LucideIcon> = {
	overview: LayoutDashboard,
	execute: TerminalSquare,
	files: FolderOpen,
	frp: Network,
	jobs: History,
	pi: BrainCircuit,
	terminal: SquareTerminal,
};

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
								{client.name ?? client.hostname}
							</Link>
						</CardTitle>
						<p className="mt-1 truncate font-mono text-xs text-muted-foreground">
							{client.hostname} · {client.clientId}
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
				<div className="mt-2 flex flex-wrap gap-2">
					<StatusChip
						label={privilegedLabel(client)}
						tone={
							client.capabilityDetails?.privileged?.mode === "sudo-all"
								? "warning"
								: "neutral"
						}
					/>
					<StatusChip label={installationLabel(client)} />
				</div>
				<div className="mt-5 flex flex-wrap gap-3 border-t border-border/60 pt-4 text-sm">
					{MACHINE_TABS.map(([key, label]) => {
						const Icon = tabIcons[key];
						return (
							<Link
								key={key}
								className="inline-flex items-center gap-1 text-primary"
								to={`${base}/${key}`}
							>
								{Icon && <Icon className="size-4" />}
								{label}
							</Link>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
