import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PiSessionStatus } from "./use-pi-session.js";

/**
 * 输入区：idle prompt；running 时 Steer/Follow-up 切换；abort/compact；附件草稿槽。
 * 不支持 `!`/`!!` 直接 shell。
 */
export function PiChatInput({
	status,
	disabled,
	onSend,
	onSteer,
	onFollowUp,
	onAbort,
	onCompact,
	onAbortCompact,
	attachments = [],
	onPickFiles,
	onRemoveAttachment,
}: {
	status: PiSessionStatus;
	disabled: boolean;
	onSend: (prompt: string) => void;
	onSteer: (message: string) => void;
	onFollowUp: (message: string) => void;
	onAbort: () => void;
	onCompact: () => void;
	onAbortCompact: () => void;
	/** 附件草稿（仅 idle prompt 可用） */
	attachments?: Array<{
		name: string;
		status: "uploading" | "ready" | "error";
	}>;
	onPickFiles?: (files: FileList) => void;
	onRemoveAttachment?: (index: number) => void;
}) {
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"prompt" | "steer" | "followUp">("prompt");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	const running = status === "running" || status === "waiting_input";
	const promptable = status === "idle" || status === "done";
	const canSend = !disabled && promptable && text.trim().length > 0;

	const submit = () => {
		if (!canSend) return;
		const value = text.trim();
		setText("");
		if (mode === "steer") onSteer(value);
		else if (mode === "followUp") onFollowUp(value);
		else onSend(value);
	};

	useEffect(() => {
		// Esc 仅在运行中 abort
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && running && !disabled) onAbort();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [running, disabled, onAbort]);

	return (
		<div
			className="space-y-2 border-t border-border/70 bg-background/55 p-3 backdrop-blur"
			data-testid="pi-chat-composer"
		>
			{running && !disabled && (
				<div className="flex flex-wrap items-center gap-1.5 text-xs">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setMode("steer")}
					>
						Steer
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setMode("followUp")}
					>
						Follow-up
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={onCompact}>
						Compact
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={onAbortCompact}
					>
						Abort compact
					</Button>
					<Button
						type="button"
						size="sm"
						variant="destructive"
						onClick={onAbort}
					>
						中止
					</Button>
					<span className="ml-1 rounded-full bg-secondary/60 px-2 py-1 text-muted-foreground">
						{mode === "steer"
							? "Steer 模式"
							: mode === "followUp"
								? "Follow-up 模式"
								: "运行中"}
					</span>
				</div>
			)}
			{attachments.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{attachments.map((a, i) => (
						<span
							key={`${a.name}-${i}`}
							className="flex items-center gap-1 rounded-full border border-border/70 bg-card/65 px-2 py-1 text-[10px] text-muted-foreground shadow-sm"
						>
							{a.status === "uploading"
								? "⏳"
								: a.status === "error"
									? "❌"
									: "🖼️"}{" "}
							{a.name}
							{onRemoveAttachment && !disabled && promptable && (
								<button
									type="button"
									className="rounded-full px-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
									onClick={() => onRemoveAttachment(i)}
									aria-label={`移除附件 ${a.name}`}
								>
									✕
								</button>
							)}
						</span>
					))}
				</div>
			)}
			<div className="flex items-stretch gap-1.5 rounded-2xl border border-border/80 bg-card/80 p-1.5 shadow-sm backdrop-blur transition focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20">
				{onPickFiles && !disabled && promptable && (
					<label className="flex h-12 shrink-0 cursor-pointer items-center rounded-xl px-3 text-xs text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground">
						🖼️ 添加
						<input
							type="file"
							accept="image/png,image/jpeg,image/gif,image/webp"
							multiple
							className="hidden"
							disabled={disabled || running}
							onChange={(e) => {
								if (e.target.files && e.target.files.length > 0) {
									onPickFiles(e.target.files);
									e.target.value = "";
								}
							}}
						/>
					</label>
				)}
				<textarea
					ref={textareaRef}
					value={text}
					rows={1}
					disabled={disabled || !promptable}
					placeholder={
						disabled
							? "请先选择项目和会话"
							: running
								? "运行中…"
								: status === "error"
									? "运行错误，请先标记完成"
									: "输入消息，Enter 发送，Shift+Enter 换行"
					}
					className="h-12 min-h-12 flex-1 resize-none rounded-xl border-0 bg-background/55 px-3 py-3 text-sm leading-6 outline-none transition placeholder:text-muted-foreground/80 focus:bg-background/80 disabled:opacity-50"
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					aria-label="Pi 输入"
				/>
				<Button
					type="button"
					className="h-12 shrink-0 rounded-xl px-5 shadow-sm"
					disabled={!canSend}
					onClick={submit}
				>
					{running ? "运行中" : mode === "prompt" ? "发送" : "发送"}
				</Button>
			</div>
		</div>
	);
}
