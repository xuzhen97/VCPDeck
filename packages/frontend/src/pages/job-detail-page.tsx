import type { JobInfo } from "@vcpdeck/shared";
import { Card, CardContent } from "@/components/ui/card";
import { useCallback } from "react";
import { useParams } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { DownloadLinkCard } from "@/components/download-link-card";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { MarkDoneButton } from "@/components/mark-done-button";

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
	return <JobDetail job={resource.data} onChanged={resource.reload} />;
}

function JobDetail({
	job,
	onChanged,
}: {
	job: JobInfo;
	onChanged: () => void;
}) {
	const stdout = job.result?.stdout as string | undefined;
	const stderr = job.result?.stderr as string | undefined;
	return (
		<div className="space-y-6">
			<PageHeading
				title={job.type}
				description={job.jobId}
				actions={<MarkDoneButton job={job} onChanged={onChanged} />}
			/>
			<Card>
				<CardContent className="grid gap-4 pt-6 text-sm sm:grid-cols-2">
					<Field label="状态" value={job.status} />
					<Field label="Client" value={job.clientName ?? job.clientId} />
					<Field label="创建者" value={job.createdByName ?? "未知"} />
					<Field label="来源" value={job.createdVia ?? "未知"} />
					<Field label="创建时间" value={job.createdAt} />
					<Field label="结束时间" value={job.finishedAt ?? "未结束"} />
					{job.errorCode && <Field label="错误码" value={job.errorCode} />}
					{job.errorMessage && <Field label="错误" value={job.errorMessage} />}
				</CardContent>
			</Card>
			{(job.type === "file.export" || job.type === "file.import") &&
				job.status === "done" &&
				!!job.result?.key && (
					<Card>
						<CardContent className="pt-6">
							<DownloadLinkCard job={job} />
						</CardContent>
					</Card>
				)}
			{stdout && (
				<Card>
					<CardContent className="pt-6">
						<p className="mb-2 text-xs font-medium text-muted-foreground">
							标准输出
						</p>
						<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
							{stdout}
						</pre>
					</CardContent>
				</Card>
			)}
			{stderr && (
				<Card>
					<CardContent className="pt-6">
						<p className="mb-2 text-xs font-medium text-muted-foreground">
							标准错误
						</p>
						<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
							{stderr}
						</pre>
					</CardContent>
				</Card>
			)}
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
