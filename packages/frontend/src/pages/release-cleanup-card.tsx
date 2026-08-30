import type { VcpDeckClient } from "@vcpdeck/sdk";
import { useCallback, useEffect, useState } from "react";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

type ReleaseCleanupApi = Pick<
	VcpDeckClient["releases"],
	"cleanupPreview" | "cleanupRun"
>;

/** Release 存储清理卡片：只按固定策略预览和执行，不提供强制删除。 */
export function ReleaseCleanupCard({
	api,
}: {
	api: ReleaseCleanupApi;
}) {
	const load = useCallback((signal: AbortSignal) => api.cleanupPreview(signal), [api]);
	const resource = useResource(load);
	useEffect(() => {
		const timer = setInterval(() => {
			if (!document.hidden) resource.reload();
		}, 10_000);
		return () => clearInterval(timer);
	}, [resource.reload]);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [running, setRunning] = useState(false);
	const [runError, setRunError] = useState("");
	const [result, setResult] = useState<Awaited<ReturnType<ReleaseCleanupApi["cleanupRun"]>>>();

	const run = async () => {
		setRunning(true);
		setRunError("");
		setConfirmOpen(false);
		try {
			const value = await api.cleanupRun();
			setResult(value);
			resource.reload();
		} catch (error) {
			setRunError(error instanceof Error ? error.message : "清理失败");
		} finally {
			setRunning(false);
		}
	};

	if (resource.loading && !resource.data) {
		return <LoadingState label="正在读取存储清理预览…" />;
	}
	if (resource.error && !resource.data) {
		return <ErrorState message="无法读取存储清理预览" onRetry={resource.reload} />;
	}

	const preview = resource.data;
	if (!preview) return null;

	return (
		<>
			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div>
							<CardTitle>存储清理</CardTitle>
							<CardDescription>
								按固定策略回收历史 Release 正文，不删除 Release 审计记录。
							</CardDescription>
						</div>
						<Button
							size="sm"
							variant="outline"
							disabled={running}
							onClick={() => setConfirmOpen(true)}
						>
							{running ? "正在清理…" : "立即按策略清理"}
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-sm text-muted-foreground">
						保留最近 {preview.policy.successfulReleaseCount} 个成功版本；成功版本保底 {preview.policy.minimumAgeDays} 天；失败/不完整版本保留 {preview.policy.minimumAgeDays} 天；上传会话过期后宽限 {preview.policy.uploadSessionGraceHours} 小时。
					</p>
					<div className="grid gap-3 text-sm sm:grid-cols-3">
						<div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
							<p className="text-muted-foreground">可清理 Release</p>
							<p className="mt-1 font-semibold">{preview.candidates.length}</p>
						</div>
						<div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
							<p className="text-muted-foreground">过期上传会话</p>
							<p className="mt-1 font-semibold">{preview.expiredUploadSessions.count}</p>
						</div>
						<div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
							<p className="text-muted-foreground">预计回收</p>
							<p className="mt-1 font-semibold">{formatSize(preview.estimatedReclaimableBytes)}</p>
						</div>
					</div>
					{preview.candidates.length > 0 && (
						<div className="space-y-2">
							{preview.candidates.map((candidate) => (
								<div
									key={candidate.version}
									className="rounded-lg border border-border/60 px-3 py-2 text-sm"
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<span className="font-mono font-medium">{candidate.version}</span>
										<span className="text-muted-foreground">
											{`预计回收 ${formatSize(candidate.bytes)}`}
										</span>
									</div>
									<div className="mt-2 flex flex-wrap gap-2">
										{candidate.archives.map((archive) => (
											<div
												key={archive.platform}
												className="flex items-center gap-2"
											>
												<span className="font-mono text-xs">{archive.platform}</span>
												<StatusChip
													label={
														archive.providerState === "provider_unavailable"
															? "Provider 不可用"
															: formatSize(archive.bytes)
													}
													tone={
														archive.providerState === "provider_unavailable"
															? "warning"
															: "neutral"
														}
												/>
											</div>
										))}
									</div>
								</div>
							))}
						</div>
					)}
					{runError && <p role="alert" className="text-sm text-red-400">{runError}</p>}
					{result && (
						<p className="text-sm text-emerald-400">
							本轮清理完成：清理 {result.cleanedItems} 项，回收 {formatSize(result.cleanedBytes)}；已不存在 {result.alreadyMissing} 项；失败 {result.failed} 项，跳过 {result.skipped} 项；Provider 不可用 {result.providerUnavailable} 项。
						</p>
					)}
				</CardContent>
			</Card>
			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent>
					<DialogTitle>确认按策略清理存储</DialogTitle>
					<DialogDescription>
						只删除符合保留策略的归档正文和过期上传会话；Release 审计记录会保留。删除正文不可撤销。
					</DialogDescription>
					<div className="mt-6 flex justify-end gap-3">
						<Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
							取消
						</Button>
						<Button type="button" variant="destructive" onClick={run}>
							确认执行清理
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
