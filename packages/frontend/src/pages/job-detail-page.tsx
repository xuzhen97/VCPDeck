import type { JobInfo } from "@vcpdeck/shared";
import { Card, CardContent } from "@/components/ui/card";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";

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
	const stdout = job.result?.stdout as string | undefined;
	const stderr = job.result?.stderr as string | undefined;
	return (
		<div className="space-y-6">
			<PageHeading title={job.type} description={job.jobId} />
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
			{job.type === "file.export" &&
				job.status === "done" &&
				!!job.result?.key && <DownloadLinkCard job={job} />}
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

/** file.export 完成后的永久下载链接卡片 */
function DownloadLinkCard({ job }: { job: JobInfo }) {
	const sdk = useSdk();
	const [url, setUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const key = job.result?.key;
	const filename =
		String(job.payload?.path ?? "").split(/[/\\]/).pop() || "download";

	useEffect(() => {
		if (!key) {
			setFailed(true);
			return;
		}
		let cancelled = false;
		sdk.storage
			.createDownloadToken({ key: String(key), ttlSeconds: 0 })
			.then((token) => {
				if (!cancelled) setUrl(`${window.location.origin}${token.url}`);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [sdk, key]);

	return (
		<Card>
			<CardContent className="space-y-3 pt-6">
				<p className="text-xs font-medium text-muted-foreground">
					下载文件（永久链接，清理任务回收存储空间后失效）
				</p>
				{failed ? (
					<p role="alert" className="text-sm text-red-400">
						下载链接不可用
					</p>
				) : url ? (
					<>
						<a
							href={url}
							download={filename}
							className="text-sm font-medium text-primary underline underline-offset-4"
						>
							下载文件
						</a>
						<code className="block break-all rounded bg-muted p-2 text-xs">
							{url}
						</code>
					</>
				) : (
					<p className="text-sm text-muted-foreground">正在生成下载链接…</p>
				)}
			</CardContent>
		</Card>
	);
}
