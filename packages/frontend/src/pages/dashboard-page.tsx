import type {
	ClientInfo,
	FrpMappingInfo,
	JobInfo,
	PaginatedResult,
} from "@vcpdeck/shared";
import { useCallback } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";

const JOB_TYPE_LABEL: Record<string, string> = {
	exec: "命令执行",
	"file.roots": "文件根发现",
	"file.list": "文件列表",
	"file.stat": "文件属性",
	"file.readText": "文件读取",
	"file.writeText": "文件写入",
	"file.mkdir": "创建目录",
	"file.delete": "文件删除",
	"file.move": "文件移动",
	"file.export": "文件导出",
	"file.import": "文件导入",
	"frp.create": "FRP 创建",
	"frp.delete": "FRP 删除",
	"frp.list": "FRP 列表",
	"agent.run": "Agent 执行",
};

function jobTypeLabel(type: string): string {
	return JOB_TYPE_LABEL[type] ?? type;
}

function jobStatusLabel(status: string): {
	label: string;
	tone: "success" | "warning" | "danger" | "neutral";
} {
	switch (status) {
		case "done":
			return { label: "已完成", tone: "success" };
		case "running":
			return { label: "执行中", tone: "warning" };
		case "pending":
			return { label: "等待中", tone: "neutral" };
		case "waiting_input":
			return { label: "等待输入", tone: "warning" };
		case "error":
			return { label: "失败", tone: "danger" };
		case "cancelled":
			return { label: "已取消", tone: "neutral" };
		case "disconnected":
			return { label: "已断连", tone: "danger" };
		default:
			return { label: status, tone: "neutral" };
	}
}

interface DashboardData {
	clients: ClientInfo[];
	jobs: PaginatedResult<JobInfo>;
	mappings: PaginatedResult<FrpMappingInfo>;
	storage: { authorized: boolean; configured: boolean };
}

export function DashboardPage() {
	const sdk = useSdk();
	const load = useCallback(
		async (signal: AbortSignal): Promise<DashboardData> => {
			const [clients, jobs, mappings, storage] = await Promise.all([
				sdk.clients.list(signal),
				sdk.jobs.list({ pageSize: 5 }, signal),
				sdk.frp.list({}, signal),
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
	const clientMap = new Map(
		clients.map((item) => [item.clientId, item.hostname]),
	);
	const running = jobs.data.filter((job) =>
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
					detail={`最近 ${jobs.data.length} 条记录`}
				/>
				<Metric
					title="FRP 映射"
					value={mappings.total}
					detail={`${mappings.data.filter((item) => item.status === "active").length} 个 active`}
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
					{jobs.data.length === 0 ? (
						<p className="text-sm text-muted-foreground">暂无任务记录</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-border/60 text-left text-muted-foreground">
										<th className="pb-2 pr-4 font-medium">任务类型</th>
										<th className="pb-2 pr-4 font-medium">机器</th>
										<th className="pb-2 pr-4 font-medium">状态</th>
										<th className="pb-2 font-medium">创建时间</th>
									</tr>
								</thead>
								<tbody>
									{jobs.data.slice(0, 10).map((job) => {
										const hostname =
											job.clientName ??
											clientMap.get(job.clientId) ??
											job.clientId.slice(0, 8);
										const status = jobStatusLabel(job.status);
										const time = job.createdAt.slice(0, 16).replace("T", " ");
										return (
											<tr key={job.jobId} className="border-b border-border/40">
												<td className="py-2.5 pr-4">
													{jobTypeLabel(job.type)}
												</td>
												<td className="py-2.5 pr-4 text-muted-foreground">
													{hostname}
												</td>
												<td className="py-2.5 pr-4">
													<StatusChip label={status.label} tone={status.tone} />
												</td>
												<td className="py-2.5 whitespace-nowrap text-muted-foreground">
													{time}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
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
