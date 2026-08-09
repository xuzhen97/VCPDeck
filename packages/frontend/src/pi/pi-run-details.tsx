import type { PiAgentState, PiModelInfo, PiSessionJobSnapshot } from "@vcpdeck/shared";
import { Button } from "@/components/ui/button";
import type { PiThinkingSelection } from "./use-pi-session.js";

const THINKING_OPTIONS: ReadonlyArray<readonly [PiThinkingSelection, string]> = [
	["auto", "自动"], ["off", "关闭"], ["minimal", "最低"], ["low", "低"],
	["medium", "中"], ["high", "高"], ["xhigh", "超高"], ["max", "最大"],
];

function modelValue(model: PiModelInfo | undefined): string {
	return model ? `${model.provider}\u0000${model.modelId}` : "";
}

/** 右栏：Session Job 状态与 agent 运行细节（无正文）。 */
export function PiRunDetails({
	job,
	agentState,
	models,
	thinkingSelection,
	disabled,
	onModelChange,
	onThinkingChange,
	onComplete,
}: {
	job: PiSessionJobSnapshot | null;
	agentState: PiAgentState | null;
	models: PiModelInfo[];
	thinkingSelection: PiThinkingSelection;
	disabled: boolean;
	onModelChange(provider: string, modelId: string): void;
	onThinkingChange(level: PiThinkingSelection): void;
	onComplete(): void;
}) {
	const status = job?.status ?? "idle";
	const statusText: Record<string, string> = {
		idle: "空闲，可继续提问", pending: "等待运行", running: "运行中",
		waiting_input: "等待扩展输入", done: "已完成，可继续提问以重新激活",
		disconnected: "客户端已断开", error: "运行错误", cancelled: "已完成，可继续提问以重新激活",
	};
	const settingsDisabled = disabled || !job?.isOwner || status !== "idle" || agentState?.compacting === true;

	return (
		<div className="space-y-4 text-sm">
			<section aria-label="运行状态" className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">状态</h3>
				<div className="flex items-center gap-2">
					<span className={`size-2 rounded-full ${status === "idle" || status === "done" ? "bg-zinc-500" : "bg-green-500"}`} aria-hidden />
					<span>{statusText[status] ?? status}</span>
					<span className="rounded bg-secondary/60 px-1.5 py-0.5 text-[10px]">
						{job?.isOwner === false ? "只读观察者" : job?.ownerName ? `Owner: ${job.ownerName}` : "Owner"}
					</span>
				</div>
				{status === "error" && (
					<p role="alert" className="text-xs text-red-500">{job?.errorCode ?? "PI_RUNTIME_UNAVAILABLE"}：{job?.errorMessage ?? "运行失败"}</p>
				)}
				{job?.isOwner && (
					<Button type="button" variant="outline" onClick={onComplete}>
						{job.runId ? "停止并标记完成" : "标记完成"}
					</Button>
				)}
			</section>

			<section aria-label="模型设置" className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">模型</h3>
				{agentState?.model && <div className="text-xs text-muted-foreground">当前：<span className="font-mono">{agentState.model.provider} / {agentState.model.modelId}</span></div>}
				<select aria-label="模型" className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs" disabled={settingsDisabled || models.length === 0} value={modelValue(agentState?.model)} onChange={(event) => {
					const [provider, modelId] = event.target.value.split("\u0000");
					if (provider && modelId) onModelChange(provider, modelId);
				}}>
					{models.map((model) => <option key={modelValue(model)} value={modelValue(model)}>{model.provider} / {model.modelId}</option>)}
				</select>
			</section>

			<section aria-label="思考深度" className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">思考深度</h3>
				<select aria-label="思考深度" className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs" disabled={settingsDisabled} value={thinkingSelection} onChange={(event) => onThinkingChange(event.target.value as PiThinkingSelection)}>
					{THINKING_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
				</select>
			</section>

			<section aria-label="队列">
				<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">队列</h3>
				<div className="text-xs"><div>Steer: {agentState?.queuedMessages.steering.length ?? 0}</div><div>Follow-up: {agentState?.queuedMessages.followUp.length ?? 0}</div></div>
			</section>
			<section aria-label="标识">
				<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">标识</h3>
				<div className="break-all text-xs text-muted-foreground"><div>Session / Job: {job?.sessionId ?? "—"}</div><div>Current Run: {job?.runId ?? "—"}</div></div>
			</section>
		</div>
	);
}
