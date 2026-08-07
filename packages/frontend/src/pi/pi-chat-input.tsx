import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PiSessionStatus } from "./use-pi-session.js";

/**
 * 输入区：idle prompt；running 时 Steer/Follow-up 切换；abort/compact。
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
}: {
	status: PiSessionStatus;
	disabled: boolean;
	onSend: (prompt: string) => void;
	onSteer: (message: string) => void;
	onFollowUp: (message: string) => void;
	onAbort: () => void;
	onCompact: () => void;
	onAbortCompact: () => void;
}) {
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"prompt" | "steer" | "followUp">("prompt");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	const running = status === "running" || status === "waiting_input";
	const canSend = !disabled && !running && text.trim().length > 0;

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
			if (e.key === "Escape" && running) onAbort();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [running, onAbort]);

	return (
		<div className="space-y-1.5 border-t border-border pt-2">
			{running && (
				<div className="flex items-center gap-1.5 text-xs">
					<Button type="button" size="sm" variant="outline" onClick={() => setMode("steer")}>
						Steer
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={() => setMode("followUp")}>
						Follow-up
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={onCompact}>
						Compact
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={onAbortCompact}>
						Abort compact
					</Button>
					<Button type="button" size="sm" variant="destructive" onClick={onAbort}>
						中止
					</Button>
					<span className="ml-1 text-muted-foreground">
						{mode === "steer"
							? "Steer 模式"
							: mode === "followUp"
								? "Follow-up 模式"
								: "运行中"}
					</span>
				</div>
			)}
			<div className="flex items-end gap-2">
				<textarea
					ref={textareaRef}
					value={text}
					rows={2}
					disabled={disabled || running}
					placeholder={
						disabled
							? "Pi 不可用"
							: running
								? "运行中…"
								: "输入消息，Enter 发送，Shift+Enter 换行"
					}
					className="min-h-10 flex-1 resize-none rounded border border-border bg-background p-2 text-sm disabled:opacity-50"
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					aria-label="Pi 输入"
				/>
				<Button type="button" disabled={!canSend} onClick={submit}>
					{running ? "运行中" : mode === "prompt" ? "发送" : "发送"}
				</Button>
			</div>
		</div>
	);
}
