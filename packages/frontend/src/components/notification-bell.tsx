import type { JobInfo, JobProgress } from "@vcpdeck/shared";
import {
	Bell,
	CheckCircle2,
	CircleAlert,
	CircleX,
	LoaderCircle,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import { startBrowserDownload } from "@/api/download-file";
import { Button } from "@/components/ui/button";

const POLL_MS = 500;
const ACTIVE_STATUSES = new Set(["pending", "running", "waiting_input"]);
const HIDDEN_JOB_TYPES = new Set([
	"file.roots",
	"file.list",
	"file.stat",
	"file.readText",
	"frp.list",
]);

interface FinishedItem {
	jobId: string;
	type: string;
	status: "done" | "error" | "cancelled";
	filename: string;
	key?: string;
	message?: string;
}

/** 全局任务铃铛：进行中进度 / 新完成可下载 / 失败可清除（会话内存态） */
export function NotificationBell() {
	const sdk = useSdk();
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState<JobInfo[]>([]);
	const [finished, setFinished] = useState<FinishedItem[]>([]);
	const seenRunning = useRef(new Set<string>());
	const polling = useRef(false);

	const poll = useCallback(async () => {
		if (polling.current) return;
		polling.current = true;
		try {
			const page = await sdk.jobs.list({ pageSize: 100 });
			const visibleJobs = page.data.filter(
				(j) => !HIDDEN_JOB_TYPES.has(j.type),
			);
			const nowRunning = new Set(
				visibleJobs
					.filter((j) => ACTIVE_STATUSES.has(j.status))
					.map((j) => j.jobId),
			);
			// 上次 running 现在消失的 job → 查终态，识别新完成/失败
			const newlyFinished: string[] = [];
			for (const prevId of seenRunning.current) {
				if (!nowRunning.has(prevId)) newlyFinished.push(prevId);
			}
			seenRunning.current = nowRunning;
			setActive(visibleJobs.filter((j) => ACTIVE_STATUSES.has(j.status)));

			for (const jobId of newlyFinished) {
				const job = await sdk.jobs.get(jobId);
				if (ACTIVE_STATUSES.has(job.status)) continue; // 竞态：又变 running
				setFinished((prev) => [
					...prev.filter((f) => f.jobId !== jobId),
					{
						jobId,
						type: job.type,
						status: job.status as FinishedItem["status"],
						filename: filenameOf(job),
						key: job.result?.key ? String(job.result.key) : undefined,
						message: job.errorMessage ?? job.errorCode ?? undefined,
					},
				]);
			}
		} catch {
			// 轮询失败静默，下轮重试
		} finally {
			polling.current = false;
		}
	}, [sdk]);

	useEffect(() => {
		void poll();
		const timer = setInterval(() => {
			if (!document.hidden) void poll();
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [poll]);

	const activeCount = active.length;

	return (
		<div className="relative">
			<Button
				type="button"
				size="icon"
				variant="ghost"
				aria-label={open ? "收起任务通知" : "任务通知"}
				onClick={() => setOpen((v) => !v)}
				className="relative"
			>
					<Bell aria-hidden="true" className="size-4" />
					{activeCount > 0 && (
						<span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
							{activeCount}
						</span>
					)}
				</Button>
			{open && (
				<div
					role="dialog"
					aria-label="任务通知"
					className="absolute right-0 top-11 z-50 w-[min(22.5rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border/80 bg-background/95 shadow-2xl backdrop-blur-xl"
				>
					<header className="flex items-center justify-between border-b border-border/70 px-4 py-3">
						<div className="flex items-center gap-2">
							<Bell
								aria-hidden="true"
								className="size-4 text-primary"
							/>
							<h2 className="text-sm font-semibold">任务通知</h2>
						</div>
						{activeCount > 0 && (
							<span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
								{activeCount} 个进行中
							</span>
						)}
					</header>
					<div className="max-h-[min(32rem,calc(100dvh-6rem))] overflow-y-auto p-3">
						{active.length === 0 && finished.length === 0 && (
							<p className="py-8 text-center text-sm text-muted-foreground">
								暂无任务
							</p>
						)}
						{active.length > 0 && (
							<section aria-labelledby="active-tasks-heading" className="mb-4">
								<h3
									id="active-tasks-heading"
									className="mb-2 px-1 text-xs font-semibold text-muted-foreground"
								>
									进行中
								</h3>
								<div className="space-y-2">
									{active.map((job) => (
										<div
											key={job.jobId}
											className="rounded-xl border border-primary/20 bg-primary/5 p-3"
										>
											<div className="mb-2 flex min-w-0 items-center gap-2">
												<LoaderCircle
													aria-hidden="true"
													className="size-4 shrink-0 text-primary motion-safe:animate-spin"
												/>
												<p className="min-w-0 truncate text-sm font-medium">
													{jobTypeLabel(job.type)}：{filenameOf(job)}
												</p>
											</div>
											<ProgressBar
												progress={job.progress}
												status={job.status}
												type={job.type}
												storageKind={
													job.payload?.storageKind === "alibaba"
														? "alibaba"
														: "local"
												}
											/>
										</div>
									))}
								</div>
							</section>
						)}
						{finished.length > 0 && (
							<section aria-labelledby="finished-tasks-heading">
								<h3
									id="finished-tasks-heading"
									className="mb-2 px-1 text-xs font-semibold text-muted-foreground"
								>
									最近结果
								</h3>
								<div className="space-y-2">
									{finished.map((item) => {
										const StatusIcon =
											item.status === "done"
												? CheckCircle2
												: item.status === "error"
													? CircleAlert
													: CircleX;
										const statusClass =
											item.status === "done"
												? "border-emerald-500/25 bg-emerald-500/5"
												: item.status === "error"
													? "border-red-500/25 bg-red-500/5"
													: "border-border/70 bg-secondary/20";
										const iconClass =
											item.status === "done"
												? "text-emerald-500"
												: item.status === "error"
													? "text-red-400"
													: "text-muted-foreground";
										return (
											<div
												key={item.jobId}
												className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${statusClass}`}
											>
												<StatusIcon
													aria-hidden="true"
													className={`mt-0.5 size-4 shrink-0 ${iconClass}`}
												/>
												<div className="min-w-0 flex-1">
													<p className="truncate font-medium">
														{item.status === "done"
															? `完成：${item.filename}`
															: item.status === "error"
																? `失败：${item.filename}`
																: `已取消：${item.filename}`}
													</p>
													{item.status === "error" && item.message && (
														<p className="mt-0.5 truncate text-xs text-red-400">
															{item.message}
														</p>
													)}
													{item.status === "done" &&
														(item.type === "file.export" ||
															item.type === "file.import") &&
														item.key && (
															<DownloadButton
																key={item.jobId}
																storageKey={item.key}
																filename={item.filename}
															/>
														)}
												</div>
												<Button
													type="button"
													size="icon"
													variant="ghost"
													className="size-11 min-h-11 shrink-0"
													aria-label={`清除通知 ${item.jobId}`}
													title="清除通知"
													onClick={() =>
														setFinished((prev) =>
															prev.filter((f) => f.jobId !== item.jobId),
														)
													}
												>
													<X aria-hidden="true" className="size-4" />
												</Button>
											</div>
										);
									})}
								</div>
							</section>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function ProgressBar({
	progress,
	status,
	type,
	storageKind,
}: {
	progress: JobProgress | null;
	status: string;
	type: string;
	storageKind: "local" | "alibaba";
}) {
	const stage =
		status === "waiting_input"
			? storageKind === "alibaba"
				? "正在上传到阿里云盘"
				: "正在上传到 Storage"
			: status === "pending" && type === "file.import"
				? "等待远程机器接收"
				: type === "file.import"
					? "正在导入远程机器"
					: status === "pending"
						? "等待派发"
						: "";
	if (!progress || progress.total <= 0) {
		return (
			<div>
				<div className="h-1.5 w-full rounded-full bg-muted" />
				{stage && <p className="mt-1 text-xs text-muted-foreground">{stage}</p>}
			</div>
		);
	}
	if (
		progress.loaded >= progress.total &&
		(type === "file.export" ||
			(type === "file.import" &&
				status === "waiting_input" &&
				storageKind === "alibaba"))
	) {
		return (
			<div>
				<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
					<div className="h-full w-full animate-pulse rounded-full bg-primary/70" />
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					{type === "file.import"
						? "上传完成 · 正在保存到阿里云盘…"
						: "上传完成 · 正在保存到云盘…"}
				</p>
			</div>
		);
	}
	const pct = Math.min(
		100,
		Math.round((progress.loaded / progress.total) * 100),
	);
	const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
	return (
		<div>
			<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div
					className="h-full rounded-full bg-primary"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">
				{stage && <span>{stage}</span>}
				{stage && " · "}已传 {mb(progress.loaded)} / {mb(progress.total)} MB ·{" "}
				{pct}%
			</p>
		</div>
	);
}

/** 完成项内的下载按钮。 */
function DownloadButton({
	storageKey,
	filename,
}: {
	storageKey: string;
	filename: string;
}) {
	const sdk = useSdk();
	const [notice, setNotice] = useState("");
	const doDownload = useCallback(() => {
		startBrowserDownload(sdk.storage.downloadUrl(storageKey), filename);
		setNotice("已开始下载，请查看浏览器下载栏");
		window.setTimeout(() => setNotice(""), 3000);
	}, [sdk, storageKey, filename]);

	return (
		<div>
			<Button size="sm" variant="outline" onClick={doDownload}>
				下载
			</Button>
			{notice && <p className="mt-1 text-xs text-muted-foreground">{notice}</p>}
		</div>
	);
}

function filenameOf(job: JobInfo): string {
	const path =
		job.payload?.path ?? job.payload?.targetPath ?? job.payload?.filename;
	return typeof path === "string"
		? path.split(/[/\\]/).pop() || path
		: job.type;
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
