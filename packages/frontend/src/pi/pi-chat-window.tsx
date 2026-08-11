import { useMemo, useState } from "react";
import type { PiImagePlaceholder, PiMessage } from "@vcpdeck/shared";
import { PiMessageView } from "./pi-message-view.js";
import { buildTurnGroups, type PiTurnGroup } from "./turn-groups.js";
import type { PiSessionState } from "./use-pi-session.js";
import { Button } from "@/components/ui/button";

/** 中间过程折叠块（Process Details） */
function ProcessDetails({ group }: { group: PiTurnGroup }) {
	const [expanded, setExpanded] = useState(false);
	const toolNames = useMemo(() => {
		const names = new Set<string>();
		for (const m of group.processMessages) {
			if (m.role === "assistant") {
				for (const c of m.content) {
					if (c.type === "tool_call") names.add(c.toolName);
				}
			}
		}
		return [...names].slice(0, 4);
	}, [group.processMessages]);

	return (
		<div className="pi-chat-fade-in my-2 overflow-hidden rounded-2xl border border-border/70 bg-card/65 text-xs shadow-sm backdrop-blur">
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-secondary/45"
				onClick={() => setExpanded((v) => !v)}
			>
				<span className="font-semibold text-foreground">Process Details</span>
				<span className="text-muted-foreground">
					{group.processMessageCount} 条消息 · {group.toolCallCount} 个工具调用
				</span>
				<span className="ml-auto min-w-0 truncate text-muted-foreground">
					{toolNames.join(", ")}
				</span>
				<span className="shrink-0 text-primary">
					{expanded ? "收起" : "展开"}
				</span>
			</button>
			{expanded && (
				<div className="pi-chat-fade-in space-y-1.5 border-t border-border/60 bg-background/35 px-2.5 py-2">
					{group.processMessages.map((m) => (
						<PiMessageView key={m.id} message={m} />
					))}
				</div>
			)}
		</div>
	);
}

function LiveThinkingBlock({ state }: { state: PiSessionState }) {
	const [expanded, setExpanded] = useState(false);
	if (!state.thinkingText) return null;
	const label =
		typeof state.thinkingDurationMs === "number"
			? `已思考 ${(state.thinkingDurationMs / 1000).toFixed(1)} 秒`
			: "思考中…";
	return (
		<div
			className="my-2 overflow-hidden rounded-2xl border border-border/70 bg-card/65 text-xs shadow-sm backdrop-blur"
			data-testid="live-thinking-block"
		>
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground transition hover:bg-secondary/45"
				onClick={() => setExpanded((value) => !value)}
			>
				<span className="italic">{label}</span>
				<span className="ml-auto text-primary">
					{expanded ? "收起思考" : "展开思考"}
				</span>
			</button>
			{expanded && (
				<pre className="pi-chat-fade-in max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 bg-background/35 px-3 py-2 text-muted-foreground">
					{state.thinkingText}
				</pre>
			)}
		</div>
	);
}

function toolResultsOf(messages: PiMessage[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of messages) {
		if (m.role === "tool_result") {
			out[m.toolCallId] = m.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
		}
	}
	return out;
}

function LoadingDots() {
	return (
		<span className="inline-flex items-center gap-1.5" aria-hidden="true">
			<span className="pi-chat-loading-dot" />
			<span className="pi-chat-loading-dot" />
			<span className="pi-chat-loading-dot" />
		</span>
	);
}

/** 中栏：结构化时间线（用户/最终回答/Process Details） */
export function PiChatWindow({
	state,
	info,
	onLoadMore,
	onImageLoad,
	imageUrls = {},
}: {
	state: PiSessionState;
	info: { id: string; name: string; firstMessage: string | null } | null;
	onLoadMore: () => void;
	onImageLoad?: (block: PiImagePlaceholder) => void;
	imageUrls?: Record<string, string>;
}) {
	const groups = useMemo(
		() => buildTurnGroups(state.messages),
		[state.messages],
	);
	const toolResults = useMemo(
		() => toolResultsOf(state.messages),
		[state.messages],
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
				data-testid="pi-chat-window"
			>
				{info && (
					<div className="text-center text-xs text-muted-foreground">
						{info.name || info.firstMessage || "新会话"}
					</div>
				)}
				{state.error && (
					<div className="rounded-xl border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs text-destructive">
						{state.error}
					</div>
				)}
				{state.hasMore && (
					<div className="text-center">
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={onLoadMore}
						>
							加载更早消息
						</Button>
					</div>
				)}
				{state.status === "loading" && (
					<div
						className="flex justify-center py-16"
						data-testid="pi-history-loading"
					>
						<div className="pi-chat-fade-in inline-flex items-center gap-3 rounded-full border border-border/70 bg-card/70 px-4 py-2 text-sm text-muted-foreground shadow-sm backdrop-blur">
							<LoadingDots />
							<span>正在加载历史消息…</span>
						</div>
					</div>
				)}
				{state.status !== "loading" &&
					state.messages.length === 0 &&
					!state.error && (
						<div className="py-16 text-center text-sm text-muted-foreground">
							开始一段新的 Pi 会话
						</div>
					)}
				<LiveThinkingBlock state={state} />
				{groups.map((group, gi) => (
					<div key={group.userMessage?.id ?? `g${gi}`} className="space-y-2">
						{group.userMessage && (
							<div className="flex justify-end">
								<div className="max-w-[85%]">
									<PiMessageView message={group.userMessage} />
								</div>
							</div>
						)}
						{group.processMessages.length > 0 && (
							<ProcessDetails group={group} />
						)}
						{group.finalAssistant && (
							<div className="max-w-[95%]">
								<PiMessageView
									message={group.finalAssistant}
									toolResults={toolResults}
									onImageLoad={onImageLoad}
									imageUrls={imageUrls}
								/>
							</div>
						)}
					</div>
				))}
				{state.status === "running" && (
					<div
						className="pi-chat-fade-in inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/70 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur"
						data-testid="streaming-indicator"
					>
						<LoadingDots />
						<span>Pi 正在处理…</span>
					</div>
				)}
			</div>
		</div>
	);
}
