import type { ClientInfo, DiskInfo } from "@vcpdeck/shared";
import {
	Clock3,
	Cpu,
	HardDrive,
	MemoryStick,
	MonitorCog,
	Package,
	TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { OperatingSystemIcon } from "@/components/operating-system-icon";
import { Card, CardContent } from "@/components/ui/card";
import { StatusChip } from "@/components/status-chip";
import { capabilitiesLabel } from "@/lib/utils";
import { ExecutePanel } from "@/pages/execute-panel";
import { FilesPanel } from "@/pages/files-panel";
import { FrpPanel } from "@/pages/frp-panel";
import { JobsPage } from "@/pages/jobs-page";
import { PiPanel } from "@/pages/pi-panel";

const tabs = [
	["overview", "概览"],
	["execute", "执行"],
	["files", "文件"],
	["frp", "FRP"],
	["jobs", "任务记录"],
	["pi", "Pi"],
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
		<div
			data-testid="machine-workspace"
			className="flex h-full min-h-0 flex-col gap-4"
		>
			<header
				data-testid="machine-workspace-header"
				className="shrink-0 space-y-3 border-b border-border/70 pb-0"
			>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<div className="flex min-w-0 items-center gap-3">
						<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
							<OperatingSystemIcon os={client.os} className="size-6" />
						</div>
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
						<div className="group relative shrink-0">
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
			<div
				data-testid="machine-workspace-content"
				className={`min-h-0 flex-1 ${tab === "files" ? "overflow-hidden" : "overflow-y-auto pr-1"}`}
			>
				{tab === "overview" && <Overview client={client} />}
				{tab === "execute" && <ExecutePanel clientId={client.clientId} />}
				{tab === "files" && <FilesPanel clientId={client.clientId} />}
				{tab === "frp" && <FrpPanel clientId={client.clientId} />}
				{tab === "jobs" && <JobsPage clientId={client.clientId} />}
				{tab === "pi" && <PiPanel client={client} />}
				{!["overview", "execute", "files", "frp", "jobs", "pi"].includes(tab) && (
					<Card>
						<CardContent className="pt-6 text-sm text-muted-foreground">
							{tabs.find(([key]) => key === tab)?.[1] ?? "未知页面"}
							将在对应阶段接入。
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	);
}

// client 上报的 totalMemMB/totalDiskMB 实为 MiB（bytes ÷ 1024²），
// 展示按 GiB 口径（÷1024）换算，与资源管理器、文件面板一致
const fmt = (v: number | undefined) => {
	if (v == null) return "—";
	return v >= 1024 * 1024
		? (v / (1024 * 1024)).toFixed(1) + " TB"
		: v >= 1024
			? (v / 1024).toFixed(0) + " GB"
			: v + " MB";
};

function Overview({ client }: { client: ClientInfo }) {
	return (
		<div className="space-y-4">
			<div className="grid gap-4 lg:grid-cols-3">
				<ResourceCard
					label="CPU"
					detail={client.cpuModel ?? "—"}
					value={client.cpuPercent}
					icon={<Cpu className="size-5" />}
				/>
				<ResourceCard
					label="内存"
					detail={fmt(client.totalMemMB)}
					value={client.memPercent}
					icon={<MemoryStick className="size-5" />}
				/>
				<DiskCard disks={client.disks} />
			</div>
			<Card>
				<CardContent
					data-testid="system-information"
					className="grid gap-4 pt-6 sm:grid-cols-3"
				>
					<SystemField
						label="操作系统"
						value={client.os ?? "—"}
						icon={<MonitorCog className="size-4" />}
					/>
					<SystemField
						label="Client 版本"
						value={client.clientVersion ?? "—"}
						icon={<Package className="size-4" />}
					/>
					<SystemField
						label="最后心跳"
						icon={<Clock3 className="size-4" />}
						value={
							client.lastHeartbeatAt
								? new Date(client.lastHeartbeatAt).toLocaleString()
								: "未知"
						}
					/>
				</CardContent>
			</Card>
		</div>
	);
}

function ResourceCard({
	label,
	detail,
	value,
	icon,
}: {
	label: string;
	detail: string;
	value: number | null | undefined;
	icon: React.ReactNode;
}) {
	const bounded = value == null ? 0 : Math.min(100, Math.max(0, value));
	const color =
		bounded >= 90
			? "bg-red-500"
			: bounded >= 70
				? "bg-amber-500"
				: "bg-primary";
	return (
		<Card>
			<CardContent className="pt-6">
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="text-sm font-medium text-muted-foreground">{label}</p>
						<p className="mt-2 text-3xl font-semibold tabular-nums">
							{value == null ? "—" : `${value.toFixed(1)}%`}
						</p>
					</div>
					<div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
						{icon}
					</div>
				</div>
				<div className="mt-5 h-2 overflow-hidden rounded-full bg-secondary">
					<div
						role="progressbar"
						aria-label={`${label}使用率`}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={value ?? undefined}
						className={`h-full rounded-full transition-[width] duration-300 ${color}`}
						style={{ width: `${bounded}%` }}
					/>
				</div>
				<p
					className="mt-3 truncate text-xs text-muted-foreground"
					title={detail}
				>
					{detail}
				</p>
			</CardContent>
		</Card>
	);
}

function DiskCard({ disks = [] }: { disks?: DiskInfo[] }) {
	return (
		<Card>
			<CardContent className="pt-6">
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="text-sm font-medium text-muted-foreground">磁盘</p>
						{disks.length === 0 && (
							<p className="mt-2 text-3xl font-semibold tabular-nums">—</p>
						)}
					</div>
					<div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<HardDrive className="size-5" />
					</div>
				</div>
				{disks.length === 0 ? (
					<p className="mt-3 text-xs text-muted-foreground">尚无磁盘数据</p>
				) : (
					<ul className="mt-5 space-y-4">
						{disks.map((disk) => {
							const bounded = Math.min(100, Math.max(0, disk.usedPercent));
							const color =
								bounded >= 90
									? "bg-red-500"
									: bounded >= 70
											? "bg-amber-500"
											: "bg-primary";
							return (
								<li key={disk.name}>
									<div className="flex items-baseline justify-between gap-3">
										<span className="text-sm font-medium">{disk.name}</span>
										<span className="text-xs text-muted-foreground">
											{fmt(disk.totalMB)} · {disk.usedPercent.toFixed(1)}%
										</span>
									</div>
									<div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
										<div
											role="progressbar"
											aria-label={`磁盘 ${disk.name} 使用率`}
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={disk.usedPercent}
											className={`h-full rounded-full transition-[width] duration-300 ${color}`}
											style={{ width: `${bounded}%` }}
										/>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function SystemField({
	label,
	value,
	icon,
}: {
	label: string;
	value: string;
	icon: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3">
			<span className="shrink-0 text-primary">{icon}</span>
			<div className="min-w-0">
				<p className="text-xs text-muted-foreground">{label}</p>
				<p className="truncate text-sm font-medium" title={value}>
					{value}
				</p>
			</div>
		</div>
	);
}
