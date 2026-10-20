import {
	A2A_TASK_STATES,
	type A2aTask,
	type A2aTaskState,
} from "@vcpdeck/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";

/** A2A 状态 → 中文标签与色调。 */
const STATE_LABELS: Record<A2aTaskState, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
	TASK_STATE_SUBMITTED: { label: "已提交", tone: "neutral" },
	TASK_STATE_WORKING: { label: "执行中", tone: "warning" },
	TASK_STATE_INPUT_REQUIRED: { label: "等待输入", tone: "warning" },
	TASK_STATE_AUTH_REQUIRED: { label: "等待授权", tone: "warning" },
	TASK_STATE_COMPLETED: { label: "已完成", tone: "success" },
	TASK_STATE_CANCELED: { label: "已取消", tone: "neutral" },
	TASK_STATE_REJECTED: { label: "已拒绝", tone: "danger" },
	TASK_STATE_FAILED: { label: "失败", tone: "danger" },
};

const PAGE_SIZE = 20;
const DETAIL_HISTORY_LENGTH = 50;

function stateLabel(state: A2aTaskState) {
	return STATE_LABELS[state] ?? { label: state, tone: "neutral" as const };
}

function messageText(task: A2aTask) {
	return task.status.message?.parts.map((part) => part.text).join(" ").trim() ?? "";
}

/** Agent 任务（A2A Task）只读视图：列表 + 详情（对话回放、产物、事件）。 */
export function AgentTasksPage() {
	const sdk = useSdk();
	const [page, setPage] = useState(1);
	const [state, setState] = useState<A2aTaskState | "">("");
	const [query, setQuery] = useState("");
	const [detailId, setDetailId] = useState<string | null>(null);
	const load = useCallback(
		(signal: AbortSignal) =>
			sdk.tasks.list(
				{
					pageSize: PAGE_SIZE,
					pageToken: String(page),
					...(state ? { status: state } : {}),
					includeArtifacts: true,
				},
				signal,
			),
		[sdk, page, state],
	);
	const resource = useResource(load);
	useEffect(() => {
		const timer = setInterval(() => {
			if (!document.hidden) resource.reload();
		}, 10_000);
		return () => clearInterval(timer);
	}, [resource.reload]);
	const tasks = useMemo(() => {
		const rows = resource.data?.tasks ?? [];
		if (!query) return rows;
		const needle = query.toLowerCase();
		return rows.filter((task) =>
			`${task.id} ${task.contextId} ${task.metadata?.vcpdeck.agentId ?? ""} ${task.metadata?.vcpdeck.intent ?? ""} ${messageText(task)}`
				.toLowerCase()
				.includes(needle),
		);
	}, [resource.data, query]);
	const totalPages = resource.data
		? Math.max(1, Math.ceil(resource.data.totalSize / PAGE_SIZE))
		: 1;
	if (resource.loading) return <LoadingState label="正在加载 Agent 任务…" />;
	if (resource.error)
		return <ErrorState message="无法加载 Agent 任务" onRetry={resource.reload} />;
	return (
		<div className="space-y-4">
			<PageHeading
				title="Agent 任务"
				description="agent 之间的委托记录（A2A Task）：谁派给哪个 agent、执行到哪一步、回了什么。与「任务」页的 Typed Job 不是同一套模型。"
			/>
			<div className="flex flex-col gap-3 sm:flex-row">
				<Input
					aria-label="筛选 Agent 任务"
					placeholder="筛选当前页的任务号、agent 或指令"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<select
					aria-label="按状态筛选"
					className="h-11 rounded-lg border border-input bg-background/60 px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 sm:w-44"
					value={state}
					onChange={(event) => {
						setState(event.target.value as A2aTaskState | "");
						setPage(1);
					}}
				>
					<option value="">全部状态</option>
					{A2A_TASK_STATES.map((item) => (
						<option key={item} value={item}>
							{stateLabel(item).label}
						</option>
					))}
				</select>
			</div>
			<Card>
				<CardContent className="p-0">
					{tasks.length === 0 ? (
						<p className="p-6 text-sm text-muted-foreground">
							暂无 Agent 任务。用 `vcpdeck tasks send` 或 A2A `SendMessage` 派活后会出现在这里。
						</p>
					) : (
						<div className="overflow-x-auto">
							<table aria-label="Agent 任务" className="w-full text-left text-sm">
								<thead className="border-b border-border/70 bg-secondary/30 text-xs text-muted-foreground">
									<tr>
										<th className="px-4 py-3 font-medium">任务</th>
										<th className="px-4 py-3 font-medium">Agent</th>
										<th className="px-4 py-3 font-medium">指令 / 最后消息</th>
										<th className="px-4 py-3 font-medium">状态</th>
										<th className="px-4 py-3 font-medium">产物</th>
										<th className="px-4 py-3 font-medium">更新时间</th>
										<th className="px-4 py-3 text-right font-medium">操作</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/60">
									{tasks.map((task) => {
										const meta = task.metadata?.vcpdeck;
										const status = stateLabel(task.status.state);
										return (
											<tr key={task.id}>
												<td className="px-4 py-3 font-mono text-xs">{task.id}</td>
												<td className="px-4 py-3">{meta?.agentId ?? "—"}</td>
												<td className="max-w-[26rem] truncate px-4 py-3 text-muted-foreground">
													{meta?.intent || messageText(task) || "—"}
												</td>
												<td className="px-4 py-3">
													<StatusChip label={status.label} tone={status.tone} />
												</td>
												<td className="px-4 py-3 text-muted-foreground">
													{task.artifacts.length}
												</td>
												<td className="px-4 py-3 text-muted-foreground">
													{meta?.updatedAt
														? new Date(meta.updatedAt).toLocaleString()
														: "—"}
												</td>
												<td className="px-4 py-3 text-right">
													<Button
														size="sm"
														variant="outline"
														onClick={() => setDetailId(task.id)}
													>
														详情
													</Button>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					)}
				</CardContent>
			</Card>
			<div className="flex flex-wrap items-center justify-between gap-3 text-sm">
				<p className="text-muted-foreground">
					第 {page} / {totalPages} 页 · 共 {resource.data?.totalSize ?? 0} 条
				</p>
				<div className="flex gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={page <= 1}
						onClick={() => setPage((value) => Math.max(1, value - 1))}
					>
						上一页
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={!resource.data?.nextPageToken}
						onClick={() => setPage((value) => value + 1)}
					>
						下一页
					</Button>
				</div>
			</div>
			<Drawer
				open={detailId !== null}
				onClose={() => setDetailId(null)}
				title="Agent 任务详情"
				size="wide"
			>
				{detailId && <AgentTaskDetail taskId={detailId} />}
			</Drawer>
		</div>
	);
}

/** 单条 Agent 任务详情：对话回放、产物、元数据与事件时间线。 */
function AgentTaskDetail({ taskId }: { taskId: string }) {
	const sdk = useSdk();
	const load = useCallback(
		(signal: AbortSignal) => sdk.tasks.get(taskId, DETAIL_HISTORY_LENGTH, signal),
		[sdk, taskId],
	);
	const resource = useResource(load);
	const loadEvents = useCallback(
		(signal: AbortSignal) => sdk.tasks.events(taskId, { limit: 50 }, signal),
		[sdk, taskId],
	);
	const events = useResource(loadEvents);
	if (resource.loading) return <LoadingState label="正在加载任务详情…" />;
	if (resource.error || !resource.data)
		return <ErrorState message="无法加载任务详情" onRetry={resource.reload} />;
	const task = resource.data;
	const meta = task.metadata?.vcpdeck;
	const status = stateLabel(task.status.state);
	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StatusChip label={status.label} tone={status.tone} />
				<span className="font-mono text-xs text-muted-foreground">{task.id}</span>
			</div>
			<dl className="grid gap-3 text-sm sm:grid-cols-2">
				<div>
					<dt className="text-xs text-muted-foreground">目标 agent</dt>
					<dd>{meta?.agentId ?? "—"}</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">上下文</dt>
					<dd className="font-mono text-xs">{task.contextId}</dd>
				</div>
				<div className="sm:col-span-2">
					<dt className="text-xs text-muted-foreground">意图</dt>
					<dd className="whitespace-pre-wrap">{meta?.intent || "—"}</dd>
				</div>
				{meta?.acceptanceCriteria?.length ? (
					<div className="sm:col-span-2">
						<dt className="text-xs text-muted-foreground">验收标准</dt>
						<dd>
							<ul className="list-disc pl-5">
								{meta.acceptanceCriteria.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</dd>
					</div>
				) : null}
			</dl>
			<section className="space-y-2">
				<h3 className="text-sm font-semibold">对话回放</h3>
				{task.history?.length ? (
					<ol className="space-y-2">
						{task.history.map((message) => (
							<li
								key={message.messageId}
								className={`rounded-lg border p-3 text-sm ${
									message.role === "agent"
										? "border-emerald-500/20 bg-emerald-500/5"
										: "border-border bg-secondary/30"
								}`}
							>
								<p className="mb-1 text-xs text-muted-foreground">
									{message.role === "agent" ? "agent" : "user"}
								</p>
								<p className="whitespace-pre-wrap">
									{message.parts.map((part) => part.text).join("\n")}
								</p>
							</li>
						))}
					</ol>
				) : (
					<p className="text-sm text-muted-foreground">
						该任务没有回放记录（旧任务只存摘要，或尚未产生回合）。
					</p>
				)}
			</section>
			<section className="space-y-2">
				<h3 className="text-sm font-semibold">产物</h3>
				{task.artifacts.length === 0 ? (
					<p className="text-sm text-muted-foreground">暂无产物。</p>
				) : (
					<ul className="space-y-1 text-sm">
						{task.artifacts.map((artifact) => (
							<li key={artifact.id} className="flex flex-wrap gap-2">
								<span className="font-mono text-xs">{artifact.name}</span>
								<span className="text-xs text-muted-foreground">
									{artifact.mimeType}
									{typeof artifact.size === "number" ? ` · ${artifact.size} B` : ""}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
			<section className="space-y-2">
				<h3 className="text-sm font-semibold">事件时间线</h3>
				{events.loading ? (
					<p className="text-sm text-muted-foreground">正在加载事件…</p>
				) : events.error || !events.data?.data.length ? (
					<p className="text-sm text-muted-foreground">暂无事件记录。</p>
				) : (
					<ol className="space-y-1 text-xs">
						{events.data.data.map((event) => (
							<li key={event.id} className="flex flex-wrap gap-2">
								<span className="font-mono text-muted-foreground">
									#{event.id}
								</span>
								<span>{event.event}</span>
								<span className="text-muted-foreground">{event.source}</span>
								<span className="text-muted-foreground">
									{new Date(event.at).toLocaleTimeString()}
								</span>
							</li>
						))}
					</ol>
				)}
			</section>
		</div>
	);
}
