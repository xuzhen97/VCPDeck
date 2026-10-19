import { useEffect, useMemo, useRef, useState } from "react";
import {
	Bot,
	CheckCircle2,
	CircleDashed,
	Loader2,
	User,
	Wrench,
} from "lucide-react";
import type {
	AcpAdapterEvent,
	AcpPlanEntry,
	RemoteDevSessionInfo,
} from "@vcpdeck/shared";
import { StatusChip } from "@/components/status-chip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { agentStateBadge } from "../remote-dev/presentation.js";
import type { RemoteDevSocket } from "../remote-dev/remote-dev-socket.js";

/** 时间线上的一项：发起任务的用户消息，或 agent 侧事件。 */
type Entry = { type: "user"; id: string; text: string } | AcpAdapterEvent;

/** 渲染用的归并块。 */
type Block =
	| { kind: "user"; key: string; text: string }
	| { kind: "message"; key: string; text: string }
	| { kind: "thought"; key: string; text: string }
	| { kind: "tool"; key: string; title: string; status?: string }
	| { kind: "plan"; key: string; entries: AcpPlanEntry[] }
	| { kind: "ended"; key: string; reason: string };

const MAX_VISIBLE_ENTRIES = 800;

/**
 * 把事件流归并成对话块。
 *
 * 连续的 `agent.message.delta` 合并成一段正文、连续 `thought.delta` 合并成一段思考，
 * 工具调用按 `toolCallId` 就地更新状态，避免把流式增量逐条渲染成日志。
 */
function toBlocks(entries: Entry[]): Block[] {
	const blocks: Block[] = [];
	for (const [index, entry] of entries.entries()) {
		const key = `${index}`;
		if (entry.type === "user") {
			blocks.push({ kind: "user", key, text: entry.text });
			continue;
		}
		switch (entry.type) {
			case "agent.message.delta": {
				const last = blocks[blocks.length - 1];
				if (last?.kind === "message" && last.key.endsWith(entry.messageId)) {
					last.text += entry.text;
				} else {
					blocks.push({
						kind: "message",
						key: `${key}-${entry.messageId}`,
						text: entry.text,
					});
				}
				break;
			}
			case "agent.thought.delta": {
				const last = blocks[blocks.length - 1];
				if (last?.kind === "thought") last.text += entry.text;
				else blocks.push({ kind: "thought", key, text: entry.text });
				break;
			}
			case "tool.started":
				blocks.push({
					kind: "tool",
					key: `${key}-${entry.toolCallId}`,
					title: entry.title,
					...(entry.status ? { status: entry.status } : {}),
				});
				break;
			case "tool.updated": {
				const target = blocks.find(
					(block) =>
						block.kind === "tool" &&
						block.key.endsWith(entry.toolCallId) &&
						block.status !== "completed",
				);
				if (target?.kind === "tool") {
					if (entry.title) target.title = entry.title;
					if (entry.status) target.status = entry.status;
				}
				break;
			}
			case "plan.updated": {
				const last = blocks[blocks.length - 1];
				if (last?.kind === "plan") last.entries = entry.entries;
				else blocks.push({ kind: "plan", key, entries: entry.entries });
				break;
			}
			case "session.ended":
				blocks.push({ kind: "ended", key, reason: entry.reason });
				break;
			default:
				break;
		}
	}
	return blocks;
}

/** 工具状态的展示文案。 */
function toolStatusLabel(status?: string): {
	label: string;
	tone: "success" | "warning" | "danger" | "neutral";
} {
	switch (status) {
		case "completed":
			return { label: "完成", tone: "success" };
		case "failed":
			return { label: "失败", tone: "danger" };
		case "in_progress":
			return { label: "进行中", tone: "warning" };
		case "pending":
			return { label: "排队", tone: "neutral" };
		default:
			return { label: status ?? "已发起", tone: "neutral" };
	}
}

/** 正文片段：围栏代码块与普通段落。 */
type Segment = { kind: "text"; text: string } | { kind: "code"; text: string };

/** 按 ``` 围栏切段，未闭合的围栏按普通文本处理。 */
function splitFences(text: string): Segment[] {
	const segments: Segment[] = [];
	const pattern = /```[^\n]*\n([\s\S]*?)```/g;
	let cursor = 0;
	let match = pattern.exec(text);
	while (match !== null) {
		if (match.index > cursor) {
			segments.push({ kind: "text", text: text.slice(cursor, match.index) });
		}
		segments.push({ kind: "code", text: (match[1] ?? "").replace(/\n$/, "") });
		cursor = match.index + match[0].length;
		match = pattern.exec(text);
	}
	if (cursor < text.length) {
		segments.push({ kind: "text", text: text.slice(cursor) });
	}
	return segments;
}

/** 行内 `code` 渲染；不引入 markdown 依赖，只处理开发对话里最常见的两种记法。 */
function InlineText({ text }: { text: string }) {
	return (
		<>
			{text.split(/(`[^`\n]+`)/g).map((piece, index) =>
				piece.startsWith("`") && piece.endsWith("`") && piece.length > 2 ? (
					<code
						key={`${index}-${piece}`}
						className="rounded bg-secondary/70 px-1 py-0.5 font-mono text-[0.85em]"
					>
						{piece.slice(1, -1)}
					</code>
				) : (
					<span key={`${index}-${piece}`}>{piece}</span>
				),
			)}
		</>
	);
}

/** 正文：段落与围栏代码块。 */
function MessageText({ text }: { text: string }) {
	const segments = splitFences(text);
	return (
		<div className="space-y-2 text-sm leading-relaxed">
			{segments.map((segment, index) =>
				segment.kind === "code" ? (
					<pre
						key={`code-${index}`}
						className="overflow-x-auto rounded-lg border border-border/60 bg-background/80 p-3 text-xs"
					>
						<code>{segment.text}</code>
					</pre>
				) : (
					<p key={`text-${index}`} className="whitespace-pre-wrap break-words">
						<InlineText text={segment.text} />
					</p>
				),
			)}
		</div>
	);
}

/**
 * 自动化运行的**只读**运行记录。
 *
 * 这里刻意没有输入框与权限弹窗：RDS 是无人值守通道，人工介入开发在远程 DSH 里做
 * （`/develop`）。此面板只负责「看清跑过什么」，实时刷新仍然保留，用于旁观进度。
 */
export function RemoteDevTranscript({
	session,
	socket,
}: {
	session: RemoteDevSessionInfo;
	socket: RemoteDevSocket;
}) {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [usage, setUsage] = useState<{ used: number; size: number } | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const agent = agentStateBadge(session.agentStatus);
	const busy = session.agentStatus === "busy";

	useEffect(() => {
		return socket.onAgentEvent((event) => {
			if (event.type !== "agent.event") return;
			const next = event.event;
			setEntries((current) => {
				const appended = [...current, next];
				return appended.length > MAX_VISIBLE_ENTRIES
					? appended.slice(appended.length - MAX_VISIBLE_ENTRIES)
					: appended;
			});
			if (next.type === "usage.updated") {
				setUsage({ used: next.used, size: next.size });
			}
		});
	}, [socket]);

	const blocks = useMemo(() => toBlocks(entries), [entries]);

	// 回放历史：附着成功后 Server 会推一次 transcript，用它补齐"打开页面前"的运行。
	// 每个会话只播种一次——重连也会再推一次，重复播种会让记录翻倍。
	useEffect(() => {
		const seeded = { sessionId: "" };
		const off = socket.onTranscript((payload) => {
			if (payload.sessionId !== session.sessionId) return;
			if (seeded.sessionId === payload.sessionId) return;
			seeded.sessionId = payload.sessionId;
			const replay: Entry[] = payload.entries.map((entry) =>
				entry.kind === "prompt"
					? { type: "user", id: `seq-${entry.seq}`, text: entry.text }
					: entry.event,
			);
			if (replay.length === 0) return;
			// 先到的实时事件排在回放之后，保持时间顺序。
			setEntries((current) => [...replay, ...current]);
			for (const entry of replay) {
				if (entry.type === "usage.updated") {
					setUsage({ used: entry.used, size: entry.size });
				}
			}
		});
		return () => off();
	}, [socket, session.sessionId]);

	// 新内容到达后贴底；用户翻看历史时由浏览器自身保持滚动位置。
	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		element.scrollTop = element.scrollHeight;
	}, [blocks.length]);

	const usedRatio =
		usage && usage.size > 0 ? Math.min(1, usage.used / usage.size) : null;

	return (
		<Card className="flex min-h-[24rem] flex-col">
			<CardHeader className="flex flex-row items-center justify-between gap-3 pb-4">
				<div className="flex min-w-0 items-center gap-2">
					<CardTitle className="text-base">运行记录</CardTitle>
					<StatusChip label={agent.label} tone={agent.tone} />
					<StatusChip label="只读" tone="neutral" />
				</div>
				{usage && usedRatio !== null && (
					<div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
						<span>上下文</span>
						<span
							className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"
							role="img"
							aria-label={`上下文已用 ${usage.used}/${usage.size}`}
						>
							<span
								className="block h-full rounded-full bg-primary"
								style={{ width: `${usedRatio * 100}%` }}
							/>
						</span>
						<span className="font-mono">
							{usage.used}/{usage.size}
						</span>
					</div>
				)}
			</CardHeader>
			<CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-0">
				<div
					ref={scrollRef}
					className="flex max-h-[min(58vh,34rem)] min-h-[14rem] flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-border/60 bg-background/40 p-3"
				>
					{blocks.length === 0 ? (
						<div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
							<Bot className="size-7 opacity-60" aria-hidden="true" />
							<p className="font-medium text-foreground">还没有运行记录</p>
							<p className="max-w-sm text-xs">
								这是一条无人值守的自动化通道，不在这里对话。想交互式开发，去「开发」里启动远程
								DSH。
							</p>
						</div>
					) : (
						blocks.map((block) => {
							switch (block.kind) {
								case "user":
									return (
										<div
											key={block.key}
											className="ml-auto flex max-w-[85%] items-start gap-2"
										>
											<div className="rounded-2xl rounded-br-sm border border-primary/25 bg-primary/10 px-3.5 py-2.5 text-sm">
												<p className="whitespace-pre-wrap break-words">
													{block.text}
												</p>
											</div>
											<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
												<User className="size-4" aria-hidden="true" />
											</span>
										</div>
									);
								case "message":
									return (
										<div
											key={block.key}
											className="flex max-w-[92%] items-start gap-2"
										>
											<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
												<Bot className="size-4" aria-hidden="true" />
											</span>
											<div className="min-w-0 rounded-2xl rounded-bl-sm border border-border/60 bg-card px-3.5 py-2.5">
												<MessageText text={block.text} />
											</div>
										</div>
									);
								case "thought":
									return (
										<details
											key={block.key}
											className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground"
										>
											<summary className="cursor-pointer select-none">
												思考过程
											</summary>
											<p className="mt-2 whitespace-pre-wrap break-words italic leading-relaxed">
												{block.text}
											</p>
										</details>
									);
								case "tool": {
									const status = toolStatusLabel(block.status);
									return (
										<div
											key={block.key}
											className="flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2 text-xs"
										>
											<Wrench
												className="size-3.5 shrink-0 text-muted-foreground"
												aria-hidden="true"
											/>
											<span className="min-w-0 flex-1 truncate font-mono">
												{block.title}
											</span>
											<StatusChip label={status.label} tone={status.tone} />
										</div>
									);
								}
								case "plan":
									return (
										<div
											key={block.key}
											className="rounded-lg border border-border/60 px-3 py-2 text-xs"
										>
											<p className="mb-1.5 font-medium text-muted-foreground">
												执行计划 · {block.entries.length} 项
											</p>
											<ul className="space-y-1">
												{block.entries.map((entry) => (
													<li
														key={`${entry.content}-${entry.status ?? ""}`}
														className="flex items-start gap-2"
													>
														{entry.status === "completed" ? (
															<CheckCircle2
																className="mt-0.5 size-3.5 shrink-0 text-emerald-400"
																aria-hidden="true"
															/>
														) : (
															<CircleDashed
																className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
																aria-hidden="true"
															/>
														)}
														<span className="min-w-0 break-words">
															{entry.content}
														</span>
													</li>
												))}
											</ul>
										</div>
									);
								case "ended":
									return (
										<div
											key={block.key}
											className="rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 text-xs text-muted-foreground"
										>
											agent 会话已结束（{block.reason}）
										</div>
									);
								default:
									return null;
							}
						})
					)}
					{busy && (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
							agent 正在处理…
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
