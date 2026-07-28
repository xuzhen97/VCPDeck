import type { JobInfo } from "@vcpdeck/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";

export function JobsPage({ clientId }: { clientId?: string }) {
	const sdk = useSdk();
	const [page, setPage] = useState(1);
	const [status, setStatus] = useState("");
	const load = useCallback(
		(signal: AbortSignal) =>
			sdk.jobs.list(
				{ clientId, status: status || undefined, page, pageSize: 20 },
				signal,
			),
		[sdk, clientId, status, page],
	);
	const resource = useResource(load);
	const [query, setQuery] = useState("");
	const [selectedJob, setSelectedJob] = useState<JobInfo | null>(null);
	useEffect(() => {
		const timer = setInterval(() => {
			if (!document.hidden) resource.reload();
		}, 10_000);
		return () => clearInterval(timer);
	}, [resource.reload]);
	const jobs = useMemo(
		() =>
			(resource.data?.data ?? []).filter(
				(job) =>
					!query ||
					`${job.clientName ?? job.clientId} ${job.type} ${job.status} ${describePayload(job)}`
						.toLowerCase()
						.includes(query.toLowerCase()),
			),
		[resource.data, clientId, query],
	);
	if (resource.loading) return <LoadingState label="正在加载任务…" />;
	if (resource.error)
		return <ErrorState message="无法加载任务" onRetry={resource.reload} />;
	return (
		<div className="space-y-4">
			<PageHeading
				title={clientId ? "机器任务记录" : "任务记录"}
				description="任务记录对所有已认证身份可见"
			/>
			<div className="flex flex-col gap-3 sm:flex-row">
				<Input
					aria-label="筛选任务"
					placeholder="筛选当前页的任务类型或摘要"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				{!clientId && (
					<select
						aria-label="按状态筛选"
						className="h-11 rounded-lg border border-input bg-background/60 px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 sm:w-40"
						value={status}
						onChange={(event) => {
							setStatus(event.target.value);
							setPage(1);
						}}
					>
						<option value="">全部状态</option>
						<option value="pending">等待中</option>
						<option value="running">执行中</option>
						<option value="waiting_input">等待输入</option>
						<option value="disconnected">连接中断</option>
						<option value="done">已完成</option>
						<option value="error">失败</option>
						<option value="cancelled">已取消</option>
					</select>
				)}
			</div>
			<Card>
				<CardContent className="p-0">
					{jobs.length === 0 ? (
						<p className="p-6 text-sm text-muted-foreground">暂无匹配任务</p>
					) : (
						<div className="overflow-x-auto">
							<table aria-label="任务记录" className="w-full text-left text-sm">
								<thead className="border-b border-border/70 bg-secondary/30 text-xs text-muted-foreground">
									<tr>
										<th className="px-4 py-3 font-medium">任务</th>
										<th className="px-4 py-3 font-medium">摘要</th>
										{!clientId && (
											<th className="px-4 py-3 font-medium">机器</th>
										)}
										<th className="px-4 py-3 font-medium">状态</th>
										<th className="px-4 py-3 font-medium">发起人</th>
										<th className="px-4 py-3 font-medium">时间</th>
										<th className="px-4 py-3 text-right font-medium">操作</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/60">
									{jobs.map((job) => (
										<JobRow
											key={job.jobId}
											job={job}
											showClient={!clientId}
											onOpen={() => setSelectedJob(job)}
											onChanged={resource.reload}
										/>
									))}
								</tbody>
							</table>
						</div>
					)}
				</CardContent>
			</Card>
			{resource.data && resource.data.totalPages > 0 && (
				<div className="flex flex-wrap items-center justify-between gap-3 text-sm">
					<p className="text-muted-foreground">
						第 {resource.data.page} / {resource.data.totalPages} 页 · 共{" "}
						{resource.data.total} 条
					</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={resource.data.page <= 1}
							onClick={() => setPage((value) => Math.max(1, value - 1))}
						>
							上一页
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={resource.data.page >= resource.data.totalPages}
							onClick={() => setPage((value) => value + 1)}
						>
							下一页
						</Button>
					</div>
				</div>
			)}
			<Drawer
				open={selectedJob !== null}
				onClose={() => setSelectedJob(null)}
				title="任务详情"
			>
				{selectedJob && <JobDetails job={selectedJob} />}
			</Drawer>
		</div>
	);
}

function JobRow({
	job,
	showClient,
	onOpen,
	onChanged,
}: {
	job: JobInfo;
	showClient: boolean;
	onOpen: () => void;
	onChanged: () => void;
}) {
	return (
		<tr
			tabIndex={0}
			className="cursor-pointer transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:outline-none"
			onClick={onOpen}
			onKeyDown={(event) => {
				if (event.key === "Enter") onOpen();
			}}
		>
			<td className="whitespace-nowrap px-4 py-3 font-medium">
				{jobTypeLabel(job.type)}
			</td>
			<td className="max-w-md px-4 py-3">
				<p className="truncate" title={describePayload(job)}>
					{describePayload(job)}
				</p>
			</td>
			{showClient && (
				<td className="max-w-48 px-4 py-3 font-mono text-xs text-muted-foreground">
					<p className="truncate" title={job.clientName ?? job.clientId}>
						{job.clientName ?? job.clientId}
					</p>
				</td>
			)}
			<td className="whitespace-nowrap px-4 py-3">
				<StatusChip
					label={statusLabel(job.status)}
					tone={statusTone(job.status)}
				/>
			</td>
			<td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
				{job.createdByName ?? "未知身份"} · {sourceLabel(job.createdVia)}
			</td>
			<td
				className="whitespace-nowrap px-4 py-3 text-muted-foreground"
				title={formatTime(job.createdAt)}
			>
				{formatTime(job.createdAt)}
			</td>
			<td className="whitespace-nowrap px-4 py-3 text-right">
				<div className="flex justify-end gap-2">
					<Button
						size="sm"
						variant="ghost"
						onClick={(event) => {
							event.stopPropagation();
							onOpen();
						}}
					>
						查看详情
					</Button>
					<JobCancelButton job={job} onChanged={onChanged} stopPropagation />
				</div>
			</td>
		</tr>
	);
}

function JobCancelButton({
	job,
	onChanged,
	stopPropagation = false,
}: {
	job: JobInfo;
	onChanged: () => void;
	stopPropagation?: boolean;
}) {
	const sdk = useSdk();
	const controller = useRef<AbortController>();
	useEffect(() => () => controller.current?.abort(), []);
	if (job.type !== "exec" || !["pending", "running"].includes(job.status))
		return null;
	return (
		<Button
			size="sm"
			variant="outline"
			onClick={async (event) => {
				if (stopPropagation) event.stopPropagation();
				controller.current?.abort();
				const next = new AbortController();
				controller.current = next;
				try {
					await sdk.jobs.cancel(job.jobId, next.signal);
					await sdk.jobs.wait(job.jobId, { signal: next.signal });
					onChanged();
				} catch (reason) {
					if (!next.signal.aborted) throw reason;
				}
			}}
		>
			取消任务
		</Button>
	);
}

function JobDetails({ job }: { job: JobInfo }) {
	const stdout =
		typeof job.result?.stdout === "string" ? job.result.stdout : null;
	const stderr =
		typeof job.result?.stderr === "string" ? job.result.stderr : null;
	const exitCode = job.result?.exitCode;
	return (
		<div className="space-y-6 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{jobTypeLabel(job.type)}</span>
				<StatusChip
					label={statusLabel(job.status)}
					tone={statusTone(job.status)}
				/>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label="任务 ID" value={job.jobId} wide />
				<Field label="任务摘要" value={describePayload(job)} wide />
				<Field label="发起人" value={job.createdByName ?? "未知身份"} />
				<Field label="来源" value={sourceLabel(job.createdVia)} />
				<Field label="创建时间" value={formatTime(job.createdAt)} />
				<Field label="开始时间" value={formatTime(job.startedAt)} />
				<Field label="结束时间" value={formatTime(job.finishedAt)} />
				<Field label="执行耗时" value={formatDuration(job)} />
				{exitCode !== undefined && (
					<Field label="退出码" value={String(exitCode)} />
				)}
				{job.errorCode && <Field label="错误码" value={job.errorCode} />}
				{job.errorMessage && (
					<Field label="错误说明" value={job.errorMessage} wide />
				)}
			</div>
			{stdout && <Output label="标准输出" value={stdout} />}
			{stderr && <Output label="标准错误" value={stderr} danger />}
		</div>
	);
}

function Field({
	label,
	value,
	wide = false,
}: {
	label: string;
	value: string;
	wide?: boolean;
}) {
	return (
		<div className={wide ? "sm:col-span-2" : undefined}>
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-1 break-all font-medium">{value}</p>
		</div>
	);
}

function Output({
	label,
	value,
	danger = false,
}: {
	label: string;
	value: string;
	danger?: boolean;
}) {
	return (
		<section>
			<p
				className={`mb-2 text-xs font-medium ${danger ? "text-red-400" : "text-muted-foreground"}`}
			>
				{label}
			</p>
			<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
				{value}
			</pre>
		</section>
	);
}

function describePayload(job: JobInfo): string {
	if (
		job.type === "exec" &&
		job.payload.mode === "command" &&
		typeof job.payload.command === "string"
	)
		return `命令：${job.payload.command}`;
	if (job.type === "exec" && job.payload.mode === "script")
		return `脚本：${String(job.payload.executable ?? "未知解释器")}`;
	const path = [job.payload.rootDir, job.payload.path]
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		)
		.join("");
	if (path) return `目录：${path}`;
	return jobTypeLabel(job.type);
}

function jobTypeLabel(type: string): string {
	return (
		{
			exec: "执行命令",
			"file.roots": "发现文件根",
			"file.list": "读取目录",
			"file.stat": "读取文件信息",
			"file.readText": "读取文本",
			"file.writeText": "保存文本",
			"file.mkdir": "创建文件夹",
			"file.delete": "删除文件",
			"file.move": "移动文件",
			"file.export": "导出文件",
			"file.import": "导入文件",
			"frp.create": "创建 FRP",
			"frp.delete": "删除 FRP",
			"frp.list": "读取 FRP",
		}[type] ?? type
	);
}

function statusLabel(status: string): string {
	return (
		{
			pending: "等待中",
			running: "执行中",
			waiting_input: "等待输入",
			disconnected: "连接中断",
			cancelling: "取消中",
			cancelled: "已取消",
			done: "已完成",
			error: "失败",
		}[status] ?? status
	);
}

function statusTone(status: string): "success" | "danger" | "warning" {
	if (status === "done") return "success";
	if (status === "error" || status === "cancelled") return "danger";
	return "warning";
}

function sourceLabel(source: string | null): string {
	return (
		{ web: "Web", cli: "CLI", api: "API" }[source ?? ""] ?? source ?? "未知来源"
	);
}

function formatTime(value: string | null): string {
	return value ? new Date(value).toLocaleString() : "—";
}

function formatDuration(job: JobInfo): string {
	if (!job.startedAt || !job.finishedAt) return "—";
	const ms =
		new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
	return ms < 1000
		? `${ms} 毫秒`
		: `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} 秒`;
}
