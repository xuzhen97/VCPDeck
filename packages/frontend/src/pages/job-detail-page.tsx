import type { JobInfo } from "@vcpdeck/shared";
import { useCallback } from "react";
import { useParams } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { Card, CardContent } from "@/components/ui/card";

export function JobDetailPage() {
	const sdk = useSdk();
	const { jobId = "" } = useParams();
	const load = useCallback(
		(signal: AbortSignal) => sdk.jobs.get(jobId, signal),
		[sdk, jobId],
	);
	const resource = useResource(load);
	if (resource.loading) return <LoadingState label="正在加载任务详情…" />;
	if (resource.error || !resource.data)
		return <ErrorState message="无法加载任务详情" onRetry={resource.reload} />;
	return <JobDetail job={resource.data} />;
}

function JobDetail({ job }: { job: JobInfo }) {
	return (
		<div className="space-y-6">
			<PageHeading title={job.type} description={job.jobId} />
			<Card>
				<CardContent className="grid gap-4 pt-6 text-sm sm:grid-cols-2">
					<Field label="状态" value={job.status} />
					<Field label="Client" value={job.clientId} />
					<Field label="创建者" value={job.createdByName ?? "未知"} />
					<Field label="来源" value={job.createdVia ?? "未知"} />
					<Field label="创建时间" value={job.createdAt} />
					<Field label="结束时间" value={job.finishedAt ?? "未结束"} />
					{job.errorCode && <Field label="错误码" value={job.errorCode} />}
					{job.errorMessage && <Field label="错误" value={job.errorMessage} />}
				</CardContent>
			</Card>
			<p className="text-sm text-muted-foreground">
				为避免泄露命令、路径或凭证，详情页不展示原始 payload。
			</p>
		</div>
	);
}
function Field({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-1 break-all">{value}</p>
		</div>
	);
}
