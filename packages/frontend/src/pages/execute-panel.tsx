import type { JobCreate } from "@vcpdeck/shared";
import { useState, type FormEvent } from "react";
import { useJobAction } from "@/api/hooks/use-job-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/status-chip";

export function ExecutePanel({ clientId }: { clientId: string }) {
	const action = useJobAction();
	const [mode, setMode] = useState<"command" | "script">("command");
	const [command, setCommand] = useState("");
	const [executable, setExecutable] = useState("");
	const [args, setArgs] = useState("");
	const [script, setScript] = useState("");

	async function submit(event: FormEvent) {
		event.preventDefault();
		const payload: Record<string, unknown> = mode === "command"
			? { mode, command }
			: { mode, executable, args: args.trim() ? args.trim().split(/\s+/) : [], script };
		try { await action.run({ clientId, type: "exec", payload } satisfies JobCreate); } catch { /* 状态由 hook 展示 */ }
	}

	const busy = action.phase === "creating" || action.phase === "waiting";
	return (
		<div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
			<Card><CardHeader><CardTitle>远程执行</CardTitle></CardHeader><CardContent>
				<div role="tablist" aria-label="执行模式" className="mb-5 flex gap-2"><Button type="button" role="tab" aria-selected={mode === "command"} variant={mode === "command" ? "default" : "outline"} onClick={() => setMode("command")}>命令</Button><Button type="button" role="tab" aria-selected={mode === "script"} variant={mode === "script" ? "default" : "outline"} onClick={() => setMode("script")}>脚本</Button></div>
				<form className="space-y-4" onSubmit={submit}>
					{mode === "command" ? <div className="space-y-2"><Label htmlFor="command">命令</Label><Input id="command" value={command} onChange={(event) => setCommand(event.target.value)} required /></div> : <>
						<div className="space-y-2"><Label htmlFor="executable">解释器</Label><Input id="executable" value={executable} onChange={(event) => setExecutable(event.target.value)} required /></div>
						<div className="space-y-2"><Label htmlFor="args">参数</Label><Input id="args" value={args} onChange={(event) => setArgs(event.target.value)} /></div>
						<div className="space-y-2"><Label htmlFor="script">脚本内容</Label><textarea id="script" className="min-h-48 w-full rounded-lg border border-input bg-background/60 p-3 font-mono text-sm" value={script} onChange={(event) => setScript(event.target.value)} required /></div>
					</>}
					<Button type="submit" disabled={busy}>{busy ? "等待任务完成…" : mode === "command" ? "执行命令" : "执行脚本"}</Button>
				</form>
			</CardContent></Card>
			<ResultSummary action={action} />
		</div>
	);
}

function ResultSummary({ action }: { action: ReturnType<typeof useJobAction> }) {
	const job = action.job;
	return <Card><CardHeader><CardTitle>执行结果</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
		{!job && action.phase === "idle" && <p className="text-muted-foreground">提交后将在此显示 Job 状态摘要。</p>}
		{action.error !== undefined && <p role="alert" className="text-red-400">无法创建或等待任务</p>}
		{job && <><div className="flex items-center justify-between"><span className="font-mono text-xs">{job.jobId}</span><StatusChip label={job.status} tone={job.status === "done" ? "success" : "danger"} /></div>
			{typeof job.result?.exitCode === "number" && <p>退出码 {job.result.exitCode}</p>}
			{job.errorCode && <p className="font-mono text-red-400">{job.errorCode}</p>}
			{job.errorMessage && <p>{job.errorMessage}</p>}
			{job.startedAt && job.finishedAt && <p>{formatDuration(job.startedAt, job.finishedAt)}</p>}
			<p className="rounded-lg bg-secondary/60 p-3 text-muted-foreground">当前 Server 未持久化过程输出</p></>}
	</CardContent></Card>;
}

function formatDuration(startedAt: string, finishedAt: string): string {
	const seconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
	return `${seconds} 秒`;
}
