import type { JobInfo } from "@vcpdeck/shared";
import { useEffect, useState } from "react";
import { useSdk } from "@/api/context";

/**
 * 文件传输完成后的下载链接卡片内容（不含外层容器）。
 * URL 展示 + 点击下载；调用方负责在条件满足时渲染：
 * `(job.type === "file.export" || job.type === "file.import") && job.status === "done" && job.result?.key`
 * alibaba 后端为临时外部 URL（约 15 分钟），点击时实时生成。
 */
export function DownloadLinkCard({ job }: { job: JobInfo }) {
	const sdk = useSdk();
	const [url, setUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const key = job.result?.key;
	const filename =
		String(job.payload?.path ?? job.payload?.targetPath ?? "")
			.split(/[/\\]/)
			.pop() || "download";

	useEffect(() => {
		if (!key) {
			setFailed(true);
			return;
		}
		let cancelled = false;
		sdk.storage
			.createDownloadToken({ key: String(key), ttlSeconds: 0 })
			.then((token) => {
				if (!cancelled)
					setUrl(
						token.url.startsWith("http")
							? token.url
							: `${window.location.origin}${token.url}`,
					);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [sdk, key]);

	return (
		<div className="space-y-3">
			<p className="text-xs font-medium text-muted-foreground">
				下载文件（链接临时有效，请及时下载；清理任务回收存储空间后失效）
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
						referrerPolicy="no-referrer"
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
		</div>
	);
}
