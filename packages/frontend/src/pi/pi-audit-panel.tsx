import { useCallback, useEffect, useRef, useState } from "react";
import type { PiAuditEventInfo, PiRunInfo } from "@vcpdeck/shared";
import type { PiApi } from "@vcpdeck/sdk";

/** 每页条数(与 Server 的 1–100 上限一致)。 */
const PAGE_SIZE = 20;

type Tab = "runs" | "audit";

/**
 * 最小审计面板(ADR-0041):每轮执行摘要 + 会话操作事件。
 *
 * 只展示 Server 持久化的安全元数据(发起者、时间、状态、稳定错误码),
 * 不读取 Prompt、回复、thinking、工具参数或输出等正文。
 */
export function PiAuditPanel({
	clientId,
	sessionId,
	pi,
}: {
	clientId: string;
	sessionId: string;
	pi: Pick<PiApi, "sessionsControl">;
}) {
	const [tab, setTab] = useState<Tab>("runs");
	const [runs, setRuns] = useState<PiRunInfo[]>([]);
	const [audits, setAudits] = useState<PiAuditEventInfo[]>([]);
	const [page, setPage] = useState(1);
	const [totalPages, setTotalPages] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);

	const load = useCallback(
		async (nextTab: Tab, nextPage: number) => {
			const current = ++generation.current;
			setLoading(true);
			setError(null);
			try {
				if (nextTab === "runs") {
					const result = await pi.sessionsControl.runs(clientId, sessionId, {
						page: nextPage,
						pageSize: PAGE_SIZE,
					});
					if (generation.current !== current) return;
					setRuns(result.data);
					setTotalPages(result.totalPages);
				} else {
					const result = await pi.sessionsControl.audit(clientId, sessionId, {
						page: nextPage,
						pageSize: PAGE_SIZE,
					});
					if (generation.current !== current) return;
					setAudits(result.data);
					setTotalPages(result.totalPages);
				}
				setPage(nextPage);
			} catch (reason) {
				if (generation.current !== current) return;
				// 只显示安全信息,不回显原始响应。
				setError(reason instanceof Error ? reason.message : "读取审计失败");
			} finally {
				if (generation.current === current) setLoading(false);
			}
		},
		[clientId, sessionId, pi],
	);

	useEffect(() => {
		void load(tab, 1);
	}, [load, tab]);

	const rows = tab === "runs" ? runs.length : audits.length;

	return (
		<section aria-label="Agent 审计" className="space-y-2 text-sm">
			<div className="flex items-center gap-1">
				<button
					type="button"
					aria-pressed={tab === "runs"}
					className={`rounded px-2 py-1 text-xs ${tab === "runs" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
					onClick={() => setTab("runs")}
				>
					执行历史
				</button>
				<button
					type="button"
					aria-pressed={tab === "audit"}
					className={`rounded px-2 py-1 text-xs ${tab === "audit" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
					onClick={() => setTab("audit")}
				>
					会话操作
				</button>
			</div>

			{loading && <p className="text-xs text-muted-foreground">加载中…</p>}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
			{!loading && !error && rows === 0 && (
				<p className="text-xs text-muted-foreground">
					{tab === "runs" ? "暂无执行记录" : "暂无操作记录"}
				</p>
			)}

			{tab === "runs" && runs.length > 0 && (
				<ul className="space-y-1">
					{runs.map((run) => (
						<li key={run.runId} className="rounded border border-border px-2 py-1 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="font-mono text-[11px] text-muted-foreground">
									{run.kind === "command" ? "命令" : "提问"}
								</span>
								<span>{runStatusText(run.status)}</span>
							</div>
							<div className="text-[11px] text-muted-foreground">
								{run.actorName ?? "未知操作者"} · {formatTime(run.createdAt)}
								{durationText(run) && ` · ${durationText(run)}`}
							</div>
							{run.status === "failed" && run.errorCode && (
								<div className="text-[11px] text-red-500">{run.errorCode}</div>
							)}
						</li>
					))}
				</ul>
			)}

			{tab === "audit" && audits.length > 0 && (
				<ul className="space-y-1">
					{audits.map((event) => (
						<li key={event.id} className="rounded border border-border px-2 py-1 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span>{auditEventText(event.event)}</span>
								<span className="text-muted-foreground">
									{event.result === "ok" ? "成功" : event.result === "requested" ? "已请求" : "失败"}
								</span>
							</div>
							<div className="text-[11px] text-muted-foreground">
								{event.actorName ?? "未知操作者"} · {formatTime(event.createdAt)}
							</div>
							{event.event === "execution_mode_changed" && (
								<div className="text-[11px] text-muted-foreground">
									{modeText(event.oldExecutionMode)} → {modeText(event.newExecutionMode)}
								</div>
							)}
							{event.errorCode && (
								<div className="text-[11px] text-red-500">{event.errorCode}</div>
							)}
						</li>
					))}
				</ul>
			)}

			{totalPages > 1 && (
				<div className="flex items-center justify-between gap-2 text-xs">
					<button
						type="button"
						className="rounded border border-border px-2 py-1 disabled:opacity-50"
						disabled={loading || page <= 1}
						onClick={() => void load(tab, page - 1)}
					>
						上一页
					</button>
					<span className="text-muted-foreground">
						{page} / {totalPages}
					</span>
					<button
						type="button"
						className="rounded border border-border px-2 py-1 disabled:opacity-50"
						disabled={loading || page >= totalPages}
						onClick={() => void load(tab, page + 1)}
					>
						下一页
					</button>
				</div>
			)}
		</section>
	);
}

function runStatusText(status: PiRunInfo["status"]): string {
	switch (status) {
		case "pending":
			return "等待运行";
		case "running":
			return "运行中";
		case "waiting_input":
			return "等待扩展输入";
		case "disconnected":
			return "断线待对账";
		case "succeeded":
			return "成功";
		case "failed":
			return "失败";
		case "aborted":
			return "已中止";
	}
}

function auditEventText(event: PiAuditEventInfo["event"]): string {
	switch (event) {
		case "created":
			return "创建会话";
		case "imported":
			return "导入会话";
		case "renamed":
			return "重命名";
		case "archived":
			return "归档";
		case "restored":
			return "恢复";
		case "deleted":
			return "删除";
		case "execution_mode_changed":
			return "执行模式变更";
	}
}

function modeText(mode: PiAuditEventInfo["oldExecutionMode"]): string {
	if (mode === "supervised") return "监督";
	if (mode === "automatic") return "自动";
	return "跟随 Profile";
}

/** 只在两端时间都可核实时展示耗时,不编造。 */
function durationText(run: PiRunInfo): string | null {
	if (!run.startedAt || !run.finishedAt) return null;
	const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
	if (!Number.isFinite(ms) || ms < 0) return null;
	return `${Math.round(ms / 1000)}s`;
}

function formatTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
