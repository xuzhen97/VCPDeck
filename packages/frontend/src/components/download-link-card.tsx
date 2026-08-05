import type { JobInfo } from "@vcpdeck/shared";
import { useSdk } from "@/api/context";

/** 文件传输完成后的稳定下载链接卡片内容（不含外层容器）。 */
export function DownloadLinkCard({ job }: { job: JobInfo }) {
	const sdk = useSdk();
	const key = job.result?.key;
	const filename =
		String(job.payload?.path ?? job.payload?.targetPath ?? "")
			.split(/[/\\]/)
			.pop() || "download";
	const path = key ? sdk.storage.downloadUrl(String(key)) : null;
	const url = path ? `${window.location.origin}${path}` : null;

	return (
		<div className="space-y-3">
			<p className="text-xs font-medium text-muted-foreground">
				下载文件（地址稳定；每次访问都会刷新临时云盘链接）
			</p>
			{url ? (
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
				<p role="alert" className="text-sm text-red-400">
					下载链接不可用
				</p>
			)}
		</div>
	);
}
