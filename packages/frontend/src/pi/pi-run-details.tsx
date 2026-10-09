import type {
	PiAgentState,
	PiModelInfo,
	PiSessionSnapshot,
} from "@vcpdeck/shared";
import { isPiRunTerminal } from "@vcpdeck/shared";
import { Button } from "@/components/ui/button";
import type { PiThinkingSelection, PiSessionStatus } from "./use-pi-session.js";

/** 思考等级候选：右栏与 Agent 输入区共用，避免两处枚举漂移。 */
export const THINKING_OPTIONS: ReadonlyArray<readonly [PiThinkingSelection, string]> =
	[
		["auto", "Auto"],
		["off", "Off"],
		["minimal", "Minimal"],
		["low", "Low"],
		["medium", "Medium"],
		["high", "High"],
		["xhigh", "XHigh"],
		["max", "Max"],
	];

function modelValue(model: PiModelInfo | undefined): string {
	return model ? `${model.provider}\u0000${model.modelId}` : "";
}

/** 右栏：会话快照、活跃 Run 细节与 Owner 操作（无正文）。
 *
 * `status` 由 usePiSession 统一给出：它合并了服务端活跃 Run 与事件通道的本地态
 * （例如扩展等待态会比服务端快照更早到达），右栏不得自行推导一份。
 */
export function PiRunDetails({
	snapshot,
	status,
	agentState,
	models,
	thinkingSelection,
	disabled,
	onModelChange,
	onThinkingChange,
	onArchive,
	onRestore,
}: {
	snapshot: PiSessionSnapshot | null;
	status: PiSessionStatus;
	agentState: PiAgentState | null;
	models: PiModelInfo[];
	thinkingSelection: PiThinkingSelection;
	disabled: boolean;
	onModelChange(provider: string, modelId: string): void;
	onThinkingChange(level: PiThinkingSelection): void;
	onArchive(): void;
	onRestore(): void;
}) {
	const activeRun = snapshot?.activeRun ?? null;
	const archived = snapshot?.status === "archived";
	const statusText: Record<string, string> = {
		idle: "空闲，可继续提问",
		pending: "等待运行",
		running: "运行中",
		waiting_input: "等待扩展输入",
		done: "已完成，可继续提问以重新激活",
		disconnected: "客户端已断开",
		error: "运行错误",
		cancelled: "已完成，可继续提问以重新激活",
	};
	// 只有非终局 Run 才算"执行中";已结算/失败/中止的本轮不阻塞设置。
	const busy = activeRun !== null && !isPiRunTerminal(activeRun.status);
	const settingsDisabled =
		disabled ||
		!snapshot?.isOwner ||
		busy ||
		agentState?.compacting === true;

	return (
		<div className="space-y-4 text-sm">
			<section aria-label="运行状态" className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					状态
				</h3>
				<div className="flex items-center gap-2">
					<span
						className={`size-2 rounded-full ${status === "idle" || status === "done" ? "bg-zinc-500" : "bg-green-500"}`}
						aria-hidden
					/>
					<span>{statusText[status] ?? status}</span>
					{archived && (
						<span className="rounded bg-secondary/60 px-1.5 py-0.5 text-[10px]">
							已归档
						</span>
					)}
					<span className="rounded bg-secondary/60 px-1.5 py-0.5 text-[10px]">
						{snapshot?.isOwner === false
							? "只读观察者"
							: snapshot?.ownerName
								? `Owner: ${snapshot.ownerName}`
								: "Owner"}
					</span>
				</div>
				{/* 本轮失败的安全错误码;会话本身仍可用,失败不阻塞下一轮。 */}
				{activeRun && isPiRunTerminal(activeRun.status) && activeRun.errorCode && (
					<p role="alert" className="text-xs text-red-500">
						本轮失败:{activeRun.errorCode}
					</p>
				)}
				{snapshot?.isOwner && (
					// 归档只整理入口,不结算本轮执行,也不删除远端内容。
					<Button
						type="button"
						variant="outline"
						onClick={archived ? onRestore : onArchive}
					>
						{archived ? "恢复会话" : "归档会话"}
					</Button>
				)}
			</section>

			<section aria-label="模型设置" className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					模型
				</h3>
				{agentState?.model && (
					<div className="text-xs text-muted-foreground">
						当前：
						<span className="font-mono">
							{agentState.model.provider} / {agentState.model.modelId}
						</span>
					</div>
				)}
				<select
					aria-label="模型"
					className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
					disabled={settingsDisabled || models.length === 0}
					value={modelValue(agentState?.model)}
					onChange={(event) => {
						const [provider, modelId] = event.target.value.split("\u0000");
						if (provider && modelId) onModelChange(provider, modelId);
					}}
				>
					{/* 无候选时也必须给出可见文案：否则空下拉框看起来像界面坏了。 */}
					{models.length === 0 && (
						<option value={modelValue(agentState?.model)}>
							{agentState?.model
								? `${agentState.model.provider} / ${agentState.model.modelId}`
								: "（暂无可用模型）"}
						</option>
					)}
					{models.map((model) => (
						<option key={modelValue(model)} value={modelValue(model)}>
							{model.provider} / {model.modelId}
						</option>
					))}
				</select>
			</section>

			<section aria-label="思考深度" className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					思考深度
				</h3>
				<select
					aria-label="思考深度"
					className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
					disabled={settingsDisabled}
					value={thinkingSelection}
					onChange={(event) =>
						onThinkingChange(event.target.value as PiThinkingSelection)
					}
				>
					{THINKING_OPTIONS.map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</section>

			<section aria-label="队列">
				<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					队列
				</h3>
				<div className="text-xs">
					<div>Steer: {agentState?.queuedMessages.steering.length ?? 0}</div>
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
					<div>Session / Job: {snapshot?.sessionId ?? "—"}</div>
					<div>Current Run: {activeRun?.runId ?? "—"}</div>
				</div>
			</section>
		</div>
	);
}
