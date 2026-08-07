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
		<div className="my-1 rounded border border-border/70 bg-secondary/20 text-xs">
			<button
				type="button"
				className="flex w-full items-center gap-2 px-2 py-1 text-left"
				onClick={() => setExpanded((v) => !v)}
			>
				<span className="font-medium">Process Details</span>
				<span className="text-muted-foreground">
					{group.processMessageCount} 条消息 · {group.toolCallCount} 个工具调用
				</span>
				<span className="ml-auto truncate text-muted-foreground">
					{toolNames.join(", ")}
				</span>
				<span>{expanded ? "收起" : "展开"}</span>
			</button>
			{expanded && (
				<div className="space-y-1 border-t border-border/60 px-2 py-1.5">
					{group.processMessages.map((m) => (
						<PiMessageView key={m.id} message={m} />
					))}
				</div>
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
	const groups = useMemo(() => buildTurnGroups(state.messages), [state.messages]);
	const toolResults = useMemo(() => toolResultsOf(state.messages), [state.messages]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-testid="pi-chat-window">
				{info && (
					<div className="text-center text-xs text-muted-foreground">
						{info.name || info.firstMessage || "新会话"}
					</div>
				)}
				{state.error && (
					<div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
						{state.error}
					</div>
				)}
				{state.hasMore && (
					<div className="text-center">
						<Button type="button" size="sm" variant="outline" onClick={onLoadMore}>
							加载更早消息
						</Button>
					</div>
				)}
				{state.messages.length === 0 && !state.error && (
					<div className="py-16 text-center text-sm text-muted-foreground">
						开始一段新的 Pi 会话
					</div>
				)}
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
					<div className="text-xs text-muted-foreground" data-testid="streaming-indicator">
						运行中…
					</div>
				)}
			</div>
		</div>
	);
}
