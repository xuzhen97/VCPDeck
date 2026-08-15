import type { ReleaseClientState, ReleaseInfo, ReleaseStatus } from "@vcpdeck/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";

function releaseStatusLabel(status: ReleaseStatus): string {
	switch (status) {
		case "uploaded":
			return "已上传";
		case "updating_server":
			return "服务端更新中";
		case "updating_clients":
			return "客户端更新中";
		case "done":
			return "完成";
		case "failed":
			return "失败";
		default:
			return status;
	}
}

function releaseStatusTone(status: ReleaseStatus): "success" | "warning" | "danger" | "neutral" {
	if (status === "done") return "success";
	if (status === "failed") return "danger";
	if (status === "uploaded") return "neutral";
	return "warning";
}

function clientStateLabel(state: ReleaseClientState): string {
	switch (state) {
		case "pending":
			return "待更新";
		case "updating":
			return "更新中";
		case "done":
			return "成功";
		case "failed":
			return "失败";
		default:
			return state;
	}
}

function clientStateTone(state: ReleaseClientState): "success" | "warning" | "danger" | "neutral" {
	if (state === "done") return "success";
	if (state === "failed") return "danger";
	if (state === "updating") return "warning";
	return "neutral";
}

function formatTime(value: string | null | undefined): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString("zh-CN", { hour12: false });
}

function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes)) return "—";
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

function summarizeClients(states: Record<string, ReleaseClientState>): string {
	const entries = Object.entries(states);
	if (entries.length === 0) return "尚未开始";
	const counts = { done: 0, failed: 0, updating: 0, pending: 0 };
	for (const [, state] of entries) counts[state] += 1;
	return `成功 ${counts.done} · 失败 ${counts.failed} · 进行中 ${counts.updating} · 待更新 ${counts.pending}`;
}

/** 发版审计页：展示更新包上传、状态流转与各客户端更新结果。 */
export function ReleasesPage() {
	const sdk = useSdk();
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<ReleaseInfo | null>(null);
	const load = useCallback(
		(signal: AbortSignal) => sdk.releases.list({ page, pageSize: 20 }, signal),
		[sdk, page],
	);
	const resource = useResource(load);
	const statusResource = useResource(
		useCallback((signal: AbortSignal) => sdk.releases.status(signal), [sdk]),
	);

	useEffect(() => {
		const timer = setInterval(() => {
			if (!document.hidden) {
				resource.reload();
				statusResource.reload();
			}
		}, 10_000);
		return () => clearInterval(timer);
	}, [resource.reload, statusResource.reload]);

	const releases = useMemo(() => resource.data?.data ?? [], [resource.data]);
	const summary = useMemo(() => {
		const counts = { done: 0, failed: 0, active: 0, total: releases.length };
		for (const release of releases) {
			if (release.status === "done") counts.done += 1;
			else if (release.status === "failed") counts.failed += 1;
			else counts.active += 1;
		}
		return counts;
	}, [releases]);

	if (resource.loading) return <LoadingState label="正在加载发版记录…" />;
	if (resource.error)
		return <ErrorState message="无法加载发版记录" onRetry={resource.reload} />;

	return (
		<div className="space-y-6">
			<PageHeading
				title="发版"
				description="更新包上传、自更新状态流转与各客户端更新结果审计"
			/>
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<Card>
					<CardHeader>
						<CardTitle className="text-sm font-medium text-muted-foreground">
							服务端版本
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="font-mono text-xl font-semibold">
							{statusResource.data?.serverVersion ?? "—"}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="text-sm font-medium text-muted-foreground">
							当前活动发版
						</CardTitle>
					</CardHeader>
					<CardContent>
						{statusResource.data?.activeRelease ? (
							<p className="font-mono text-xl font-semibold">
								{statusResource.data.activeRelease.version}
							</p>
						) : (
							<p className="text-sm text-muted-foreground">无进行中发版</p>
						)}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="text-sm font-medium text-muted-foreground">
							本页统计
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-sm">
							完成 <span className="font-semibold text-emerald-400">{summary.done}</span> · 失败{" "}
							<span className="font-semibold text-red-400">{summary.failed}</span> · 进行中{" "}
							<span className="font-semibold text-amber-400">{summary.active}</span>
						</p>
					</CardContent>
				</Card>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>发版记录</CardTitle>
				</CardHeader>
				<CardContent>
					{releases.length === 0 ? (
						<p className="py-8 text-center text-sm text-muted-foreground">
							暂无发版记录——通过 CLI 上传更新包后，这里会展示完整更新过程
						</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-border/60 text-left text-muted-foreground">
										<th className="px-4 py-3 font-medium">版本</th>
										<th className="px-4 py-3 font-medium">状态</th>
										<th className="px-4 py-3 font-medium">大小</th>
										<th className="px-4 py-3 font-medium">客户端</th>
										<th className="px-4 py-3 font-medium">发起时间</th>
										<th className="px-4 py-3 font-medium">最后更新</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/60">
									{releases.map((release) => (
										<tr
											key={release.version}
											tabIndex={0}
											className="cursor-pointer transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:outline-none"
											onClick={() => setSelected(release)}
											onKeyDown={(event) => {
												if (event.key === "Enter") setSelected(release);
											}}
										>
											<td className="whitespace-nowrap px-4 py-3 font-mono font-medium">
												{release.version}
											</td>
											<td className="whitespace-nowrap px-4 py-3">
												<StatusChip
													label={releaseStatusLabel(release.status)}
													tone={releaseStatusTone(release.status)}
												/>
											</td>
											<td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
												{formatSize(release.size)}
											</td>
											<td className="px-4 py-3 text-muted-foreground">
												{summarizeClients(release.clientStates)}
											</td>
											<td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
												{formatTime(release.createdAt)}
											</td>
											<td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
												{formatTime(release.updatedAt)}
											</td>
										</tr>
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
				open={selected !== null}
				onClose={() => setSelected(null)}
				title={`发版 ${selected?.version ?? ""}`}
			>
				{selected && <ReleaseDetails release={selected} />}
			</Drawer>
		</div>
	);
}

function ReleaseDetails({ release }: { release: ReleaseInfo }) {
	const clients = Object.entries(release.clientStates);
	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center gap-2">
				<StatusChip
					label={releaseStatusLabel(release.status)}
					tone={releaseStatusTone(release.status)}
				/>
				<span className="text-sm text-muted-foreground">
					大小 {formatSize(release.size)}
				</span>
			</div>
			<div className="grid gap-3 text-sm sm:grid-cols-2">
				<div>
					<p className="font-medium">发起时间</p>
					<p className="mt-1 text-muted-foreground">{formatTime(release.createdAt)}</p>
				</div>
				<div>
					<p className="font-medium">最后更新</p>
					<p className="mt-1 text-muted-foreground">{formatTime(release.updatedAt)}</p>
				</div>
			</div>
			<div>
				<p className="text-sm font-medium">sha256</p>
				<p className="mt-1 break-all font-mono text-xs text-muted-foreground">
					{release.sha256}
				</p>
			</div>
			{release.errorMessage && (
				<div>
					<p className="text-sm font-medium">失败原因</p>
					<p className="mt-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
						{release.errorMessage}
					</p>
				</div>
			)}
			<div>
				<p className="text-sm font-medium">客户端更新明细</p>
				{clients.length === 0 ? (
					<p className="mt-1 text-sm text-muted-foreground">尚未开始</p>
				) : (
					<div className="mt-2 overflow-x-auto rounded-md border border-border/60">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border/60 text-left text-muted-foreground">
									<th className="px-3 py-2 font-medium">客户端</th>
									<th className="px-3 py-2 font-medium">状态</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border/60">
								{clients.map(([clientId, state]) => (
									<tr key={clientId}>
										<td className="max-w-56 truncate px-3 py-2 font-mono text-xs">
											{clientId}
										</td>
										<td className="px-3 py-2">
											<StatusChip
												label={clientStateLabel(state)}
												tone={clientStateTone(state)}
											/>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
}
