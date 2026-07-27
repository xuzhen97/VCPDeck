import type { ClientInfo, FrpMappingInfo, JobInfo } from "@vcpdeck/shared";
import { useCallback } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeading } from "@/components/page-heading";

interface DashboardData {
	clients: ClientInfo[];
	jobs: JobInfo[];
	mappings: FrpMappingInfo[];
	storage: { authorized: boolean; configured: boolean };
}

export function DashboardPage() {
	const sdk = useSdk();
	const load = useCallback(
		async (signal: AbortSignal): Promise<DashboardData> => {
			const [clients, jobs, mappings, storage] = await Promise.all([
				sdk.clients.list(signal),
				sdk.jobs.list(signal),
				sdk.frp.list(undefined, signal),
				sdk.aliyundrive.status(signal),
			]);
			return { clients, jobs, mappings, storage };
		},
		[sdk],
	);
	const resource = useResource(load);

	if (resource.loading) return <LoadingState label="正在加载概览…" />;
	if (resource.error || !resource.data)
		return (
			<ErrorState message="无法加载控制台概览" onRetry={resource.reload} />
		);
	const { clients, jobs, mappings, storage } = resource.data;
	const running = jobs.filter((job) =>
		["pending", "running", "disconnected"].includes(job.status),
	).length;
	return (
		<div className="space-y-6">
			<PageHeading
				title="概览"
				description="来自当前 Server 的实时操作摘要。"
			/>
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<Metric
					title="在线机器"
					value={clients.length}
					detail="仅统计当前在线 Client"
				/>
				<Metric
					title="进行中任务"
					value={running}
					detail={`最近 ${jobs.length} 条记录`}
				/>
				<Metric
					title="FRP 映射"
					value={mappings.length}
					detail={`${mappings.filter((item) => item.status === "active").length} 个 active`}
				/>
				<Metric
					title="阿里云盘"
					value={
						storage.authorized
							? "已授权"
							: storage.configured
								? "待授权"
								: "未配置"
					}
					detail="安全状态接口"
				/>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>最近任务</CardTitle>
				</CardHeader>
				<CardContent>
					{jobs.length === 0 ? (
						<p className="text-sm text-muted-foreground">暂无任务记录</p>
					) : (
						<ul className="divide-y divide-border/60">
							{jobs.slice(0, 6).map((job) => (
								<li
									key={job.jobId}
									className="flex justify-between gap-4 py-3 text-sm"
								>
									<span>
										{job.type} · {job.clientId}
									</span>
									<span className="text-muted-foreground">{job.status}</span>
								</li>
							))}
						</ul>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function Metric({
	title,
	value,
	detail,
}: {
	title: string;
	value: string | number;
	detail: string;
}) {
	return (
		<Card>
			<CardContent className="pt-6">
				<p className="text-sm text-muted-foreground">{title}</p>
				<p className="mt-2 text-3xl font-semibold">{value}</p>
				<p className="mt-2 text-xs text-muted-foreground">{detail}</p>
			</CardContent>
		</Card>
	);
}
