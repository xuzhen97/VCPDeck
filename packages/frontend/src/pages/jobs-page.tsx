import type { JobInfo } from "@vcpdeck/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function JobsPage({ clientId }: { clientId?: string }) {
	const sdk = useSdk();
	const load = useCallback((signal: AbortSignal) => sdk.jobs.list(signal), [sdk]);
	const resource = useResource(load);
	const [query, setQuery] = useState("");
	useEffect(() => {
		const timer = setInterval(() => { if (!document.hidden) resource.reload(); }, 10_000);
		return () => clearInterval(timer);
	}, [resource.reload]);
	const jobs = useMemo(() => (resource.data ?? []).filter((job) => (!clientId || job.clientId === clientId) && (!query || `${job.clientId} ${job.type} ${job.status}`.toLowerCase().includes(query.toLowerCase()))), [resource.data, clientId, query]);
	if (resource.loading) return <LoadingState label="正在加载任务…" />;
	if (resource.error) return <ErrorState message="无法加载任务" onRetry={resource.reload} />;
	return <div className="space-y-6">
		<PageHeading title={clientId ? "机器任务记录" : "最近 100 条任务"} description="任务记录对所有已认证身份可见" />
		<Input aria-label="筛选任务" placeholder="按 Client、类型或状态筛选" value={query} onChange={(event) => setQuery(event.target.value)} />
		<Card><CardContent className="pt-6">{jobs.length === 0 ? <p className="text-sm text-muted-foreground">暂无匹配任务</p> : <div className="divide-y divide-border/60">{jobs.map((job) => <JobRow key={job.jobId} job={job} onChanged={resource.reload} />)}</div>}</CardContent></Card>
	</div>;
}

function JobRow({ job, onChanged }: { job: JobInfo; onChanged: () => void }) {
	const sdk = useSdk();
	const cancellable = job.type === "exec" && ["pending", "running"].includes(job.status);
	async function cancel() {
		await sdk.jobs.cancel(job.jobId);
		await sdk.jobs.wait(job.jobId);
		onChanged();
	}
	return <article className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Link className="font-mono text-sm text-primary" to={`/jobs/${encodeURIComponent(job.jobId)}`}>{job.jobId}</Link><StatusChip label={job.status} tone={job.status === "done" ? "success" : job.status === "error" ? "danger" : "warning"} /></div><p className="mt-2 text-sm">{describePayload(job)}</p><p className="mt-1 text-xs text-muted-foreground">{job.clientId} · {job.createdByName ?? "未知身份"} · {job.createdVia ?? "未知来源"}</p></div>{cancellable && <Button variant="outline" onClick={cancel}>取消任务</Button>}</article>;
}

function describePayload(job: JobInfo): string {
	if (job.type === "exec" && job.payload.mode === "command" && typeof job.payload.command === "string") return `命令：${job.payload.command}`;
	if (job.type === "exec" && job.payload.mode === "script") return `脚本：${String(job.payload.executable ?? "未知解释器")}`;
	return job.type;
}
