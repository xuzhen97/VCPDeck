import type { JobInfo, JobProgress } from "@vcpdeck/shared";
import { Bell } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import { Button } from "@/components/ui/button";

const POLL_MS = 500;
const ACTIVE_STATUSES = new Set(["pending", "running", "waiting_input"]);

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

	const poll = useCallback(async () => {
		try {
			const page = await sdk.jobs.list({ pageSize: 5 });
			const nowRunning = new Set(
				page.data
					.filter((j) => ACTIVE_STATUSES.has(j.status))
					.map((j) => j.jobId),
			);
			// 上次 running 现在消失的 job → 查终态，识别新完成/失败
			const newlyFinished: string[] = [];
			for (const prevId of seenRunning.current) {
				if (!nowRunning.has(prevId)) newlyFinished.push(prevId);
			}
			seenRunning.current = nowRunning;
			setActive(page.data.filter((j) => ACTIVE_STATUSES.has(j.status)));

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
				<Bell className="size-4" />
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
					className="absolute right-0 top-11 z-50 w-80 rounded-xl border border-border bg-background p-3 shadow-2xl"
				>
					<p className="mb-2 text-xs font-semibold text-muted-foreground">
						任务通知
					</p>
					{active.length === 0 && finished.length === 0 && (
						<p className="py-4 text-center text-sm text-muted-foreground">
							暂无任务
						</p>
					)}
					{active.map((job) => (
						<div key={job.jobId} className="mb-3">
							<p className="mb-1 truncate text-sm font-medium">
								{jobTypeLabel(job.type)}：{filenameOf(job)}
							</p>
							<ProgressBar
								progress={job.progress}
								status={job.status}
								type={job.type}
							/>
						</div>
					))}
					{finished.map((item) => (
						<div
							key={item.jobId}
							className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-border/70 bg-secondary/20 p-2 text-sm"
						>
							<div className="min-w-0">
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
								size="sm"
								variant="ghost"
								aria-label={`清除通知 ${item.jobId}`}
								onClick={() =>
									setFinished((prev) =>
										prev.filter((f) => f.jobId !== item.jobId),
									)
								}
							>
								清除
							</Button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function ProgressBar({
	progress,
	status,
	type,
}: {
	progress: JobProgress | null;
	status: string;
	type: string;
}) {
	const stage =
		status === "waiting_input"
			? "正在上传到 Storage"
			: status === "pending"
				? "等待派发"
				: type === "file.import"
					? "正在写入远程目录"
					: "";
	if (!progress || progress.total <= 0) {
			return (
				<div>
					<div className="h-1.5 w-full rounded-full bg-muted" />
					{stage && (
						<p className="mt-1 text-xs text-muted-foreground">{stage}</p>
					)}
				</div>
			);
	}
	if (progress.loaded >= progress.total && type === "file.export") {
		return (
			<div>
				<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
					<div className="h-full w-full animate-pulse rounded-full bg-primary/70" />
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					上传完成 · 正在保存到云盘…
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
				{stage && " · "}已传 {mb(progress.loaded)} / {mb(progress.total)} MB · {pct}%
			</p>
		</div>
	);
}

/** 完成项内的下载按钮：签永久下载链接并触发浏览器下载 */
function DownloadButton({
	storageKey,
	filename,
}: {
	storageKey: string;
	filename: string;
}) {
	const sdk = useSdk();
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const doDownload = useCallback(async () => {
		setBusy(true);
		setNotice("");
		try {
			const token = await sdk.storage.createDownloadToken({
				key: storageKey,
				ttlSeconds: 0,
			});
			// download 属性显式传文件名：空值/缺省时 Chromium 按 URL/MIME 推断（得到 fileId 或 .json）
			const anchor = document.createElement("a");
			anchor.href = `${window.location.origin}${token.url}`;
			anchor.download = filename;
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			setNotice("已开始下载，请查看浏览器下载栏");
			window.setTimeout(() => setNotice(""), 3000);
		} catch {
			setNotice("下载链接生成失败");
		} finally {
			setBusy(false);
		}
	}, [sdk, storageKey, filename]);

	return (
		<div>
			<Button size="sm" variant="outline" disabled={busy} onClick={doDownload}>
				{busy ? "生成中…" : "下载"}
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
