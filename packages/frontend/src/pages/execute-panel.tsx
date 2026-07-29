import type { JobCreate } from "@vcpdeck/shared";
import { LoaderCircle, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useJobAction } from "@/api/hooks/use-job-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
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
	const [dialogOpen, setDialogOpen] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		const payload: Record<string, unknown> =
			mode === "command"
				? { mode, command }
				: {
						mode,
						executable,
						args: args.trim() ? args.trim().split(/\s+/) : [],
						script,
					};
		setDialogOpen(true);
		try {
			await action.run({ clientId, type: "exec", payload } satisfies JobCreate);
		} catch {
			/* 状态由 hook 展示 */
		}
	}

	const busy = action.phase === "creating" || action.phase === "waiting";
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>远程执行</CardTitle>
				</CardHeader>
				<CardContent>
					<div role="tablist" aria-label="执行模式" className="mb-5 flex gap-2">
						<Button
							type="button"
							role="tab"
							aria-selected={mode === "command"}
							variant={mode === "command" ? "default" : "outline"}
							onClick={() => setMode("command")}
						>
							命令
						</Button>
						<Button
							type="button"
							role="tab"
							aria-selected={mode === "script"}
							variant={mode === "script" ? "default" : "outline"}
							onClick={() => setMode("script")}
						>
							脚本
						</Button>
					</div>
					<form className="space-y-4" onSubmit={submit}>
						{mode === "command" ? (
							<div className="space-y-2">
								<Label htmlFor="command">命令</Label>
								<Input
									id="command"
									value={command}
									onChange={(event) => setCommand(event.target.value)}
									required
								/>
							</div>
						) : (
							<>
								<div className="space-y-2">
									<Label htmlFor="executable">解释器</Label>
									<Input
										id="executable"
										value={executable}
										onChange={(event) => setExecutable(event.target.value)}
										required
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="args">参数</Label>
									<Input
										id="args"
										value={args}
										onChange={(event) => setArgs(event.target.value)}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="script">脚本内容</Label>
									<textarea
										id="script"
										className="min-h-48 w-full rounded-lg border border-input bg-background/60 p-3 font-mono text-sm"
										value={script}
										onChange={(event) => setScript(event.target.value)}
										required
									/>
								</div>
							</>
						)}
						<Button type="submit" disabled={busy}>
							{busy && (
								<LoaderCircle aria-hidden className="size-4 animate-spin" />
							)}
							{busy ? "执行中…" : mode === "command" ? "执行命令" : "执行脚本"}
						</Button>
					</form>
				</CardContent>
			</Card>
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent
					aria-describedby="execution-dialog-description"
					className="max-h-[85vh] w-[min(94vw,48rem)] overflow-y-auto"
				>
					<div className="flex items-start justify-between gap-4">
						<div>
							<DialogTitle>执行任务</DialogTitle>
							<DialogDescription id="execution-dialog-description">
								远程命令的执行进度与最终结果
							</DialogDescription>
						</div>
						<DialogClose asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label="关闭"
							>
								<X aria-hidden className="size-4" />
							</Button>
						</DialogClose>
					</div>
					<ExecutionDialogContent action={action} />
				</DialogContent>
			</Dialog>
		</>
	);
}

function ExecutionDialogContent({
	action,
}: {
	action: ReturnType<typeof useJobAction>;
}) {
	if (action.phase === "creating" || action.phase === "waiting") {
		return (
			<div
				role="status"
				className="flex flex-col items-center gap-4 py-10 text-center"
			>
				<div className="rounded-full bg-primary/10 p-4 text-primary">
					<LoaderCircle aria-hidden className="size-8 animate-spin" />
				</div>
				<div>
					<p className="font-medium">
						{action.phase === "creating"
							? "正在创建任务…"
							: "正在等待机器返回结果…"}
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						关闭弹框不会取消远程任务
					</p>
				</div>
			</div>
		);
	}

	if (action.error !== undefined) {
		return (
			<p
				role="alert"
				className="mt-6 rounded-lg bg-destructive/10 p-4 text-destructive"
			>
				无法创建或等待任务
			</p>
		);
	}

	const job = action.job;
	if (!job) return null;
	const stdout =
		typeof job.result?.stdout === "string" ? job.result.stdout : null;
	const stderr =
		typeof job.result?.stderr === "string" ? job.result.stderr : null;
	return (
		<div className="mt-6 space-y-4 text-sm">
			<div className="flex items-center justify-between gap-4 rounded-lg bg-secondary/50 p-4">
				<div className="min-w-0">
					<p className="text-xs text-muted-foreground">任务 ID</p>
					<p className="truncate font-mono text-xs">{job.jobId}</p>
				</div>
				<StatusChip
					label={job.status === "done" ? "已完成" : "执行失败"}
					tone={job.status === "done" ? "success" : "danger"}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				{typeof job.result?.exitCode === "number" && (
					<ResultField label="退出码" value={String(job.result.exitCode)} />
				)}
				{job.startedAt && job.finishedAt && (
					<ResultField
						label="执行耗时"
						value={formatDuration(job.startedAt, job.finishedAt)}
					/>
				)}
			</div>
			{job.errorCode && (
				<p className="font-mono text-destructive">{job.errorCode}</p>
			)}
			{job.errorMessage && <p>{job.errorMessage}</p>}
			{stdout && <ExecutionOutput label="标准输出" value={stdout} />}
			{stderr && <ExecutionOutput label="标准错误" value={stderr} danger />}
			{!stdout && !stderr && (
				<p className="rounded-lg bg-secondary/60 p-3 text-muted-foreground">
					命令未产生标准输出
				</p>
			)}
		</div>
	);
}

function ExecutionOutput({
	label,
	value,
	danger = false,
}: {
	label: string;
	value: string;
	danger?: boolean;
}) {
	return (
		<section>
			<p
				className={`mb-2 text-xs font-medium ${danger ? "text-destructive" : "text-muted-foreground"}`}
			>
				{label}
			</p>
			<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
				{value}
			</pre>
		</section>
	);
}

function ResultField({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-border/70 p-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-1 font-medium">{value}</p>
		</div>
	);
}

function formatDuration(startedAt: string, finishedAt: string): string {
	const seconds = Math.max(
		0,
		Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
	);
	return `${seconds} 秒`;
}
