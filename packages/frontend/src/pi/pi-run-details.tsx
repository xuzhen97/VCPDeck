import type { PiAgentState } from "@vcpdeck/shared";

/** 右栏：model/thinking/context/owner/queue 等运行细节（无正文） */
export function PiRunDetails({
	agentState,
	runId,
	sessionId,
	ownerName,
	isObserver,
}: {
	agentState: PiAgentState | null;
	runId: string | null;
	sessionId: string | null;
	ownerName: string | null;
	isObserver: boolean;
}) {
	const statusText: Record<string, string> = {
		idle: "空闲",
		loading: "加载中",
		running: "运行中",
		compacting: "压缩中",
		waiting_input: "等待扩展输入",
		waiting_for_extension_input: "等待扩展输入",
		error: "错误",
	};
	const status = agentState?.status ?? "idle";

	return (
		<div className="space-y-4 text-sm">
			<section aria-label="运行状态">
				<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					状态
				</h3>
				<div className="flex items-center gap-2">
					<span
						className={`size-2 rounded-full ${
							status === "idle" ? "bg-zinc-500" : "bg-green-500"
						}`}
						aria-hidden
					/>
					<span>{statusText[status]}</span>
					{isObserver && (
						<span className="rounded bg-secondary/60 px-1.5 py-0.5 text-[10px]">
							只读观察者
						</span>
					)}
					{!isObserver && (
						<span className="rounded bg-secondary/60 px-1.5 py-0.5 text-[10px]">
							{ownerName ? `Owner: ${ownerName}` : "Owner"}
						</span>
					)}
				</div>
			</section>

			<section aria-label="模型">
				<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					模型
				</h3>
				{agentState?.model ? (
					<div className="text-xs">
						<span className="font-mono">
							{agentState.model.provider}/{agentState.model.modelId}
						</span>
					</div>
				) : (
					<div className="text-xs text-muted-foreground">—</div>
				)}
			</section>

			<section aria-label="队列">
				<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					队列
				</h3>
				<div className="text-xs">
					<div>
						Steer: {agentState?.queuedMessages.steering.length ?? 0}
					</div>
					<div>
						Follow-up: {agentState?.queuedMessages.followUp.length ?? 0}
					</div>
				</div>
			</section>

			<section aria-label="标识">
				<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					标识
				</h3>
				<div className="break-all text-xs text-muted-foreground">
					<div>Session: {sessionId ?? "—"}</div>
					<div>Run: {runId ?? "—"}</div>
				</div>
			</section>
		</div>
	);
}
