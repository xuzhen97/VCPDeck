import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
	PiImagePlaceholder,
	PiMessage,
	PiTextContent,
	PiThinkingPlaceholder,
	PiToolCallContent,
} from "@vcpdeck/shared";

/** thinking 阶段展示（正文永不渲染） */
function ThinkingBlock({ block }: { block: PiThinkingPlaceholder }) {
	const label =
		typeof block.durationMs === "number"
			? `已思考 ${(block.durationMs / 1000).toFixed(1)} 秒`
			: "思考中…";
	return (
		<div className="text-muted-foreground text-xs italic" data-testid="thinking-block">
			{label}
		</div>
	);
}

/** 图片占位（历史惰性加载，Task 13 接入短时 URL） */
function ImageBlock({ block }: { block: PiImagePlaceholder }) {
	return (
		<button
			type="button"
			className="text-xs text-blue-500 underline"
			data-testid="image-placeholder"
		>
			[图片 {block.mimeType}] 点击加载
		</button>
	);
}

/** Tool Call：默认摘要，可展开参数/结果 */
function ToolCallBlock({
	block,
	resultText,
}: {
	block: PiToolCallContent;
	resultText?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	return (
		<div className="my-1 rounded border border-zinc-700 bg-zinc-900 text-xs" data-testid="tool-call">
			<button
				type="button"
				className="flex w-full items-center gap-2 px-2 py-1 text-left"
				onClick={() => setExpanded((v) => !v)}
			>
				<span className="font-mono text-blue-400">{block.toolName}</span>
				<span className="text-muted-foreground truncate">
					{summarizeInput(block.input)}
				</span>
				<span className="ml-auto">{expanded ? "收起" : "展开"}</span>
			</button>
			{expanded && (
				<div className="border-t border-zinc-800 px-2 py-1">
					{Object.keys(block.input).length > 0 && (
						<pre className="overflow-x-auto whitespace-pre-wrap break-all">
							{JSON.stringify(block.input, null, 2)}
						</pre>
					)}
					{resultText !== undefined && (
						<div className="mt-1 border-t border-zinc-800 pt-1">
							<div className="text-zinc-500">结果</div>
							<pre className="overflow-x-auto whitespace-pre-wrap break-all">
								{resultText}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function summarizeInput(input: Record<string, unknown>): string {
	const entries = Object.entries(input);
	if (entries.length === 0) return "";
	const [k, v] = entries[0]!;
	const value = typeof v === "string" ? v : JSON.stringify(v);
	return `${k}: ${value.slice(0, 80)}${value.length > 80 ? "…" : ""}`;
}

function Markdown({ text }: { text: string }) {
	return (
		<div className="markdown-body">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				skipHtml
				components={{
					a: (props) => (
						<a {...props} rel="noreferrer noopener" target="_blank" />
					),
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}

/** 渲染单条消息（Markdown/GFM；禁 raw HTML；thinking 无正文；tool call 可展开） */
export function PiMessageView({
	message,
	toolResults = {},
}: {
	message: PiMessage;
	/** toolCallId → Tool Result 文本（展开时显示） */
	toolResults?: Record<string, string>;
}) {
	if (message.role === "user") {
		return (
			<div className="rounded-lg bg-blue-950/40 px-3 py-2" data-testid="user-message">
				{message.content.map((block, i) => {
					if (block.type === "text") return <Markdown key={i} text={block.text} />;
					if (block.type === "image") return <ImageBlock key={i} block={block} />;
					return null;
				})}
			</div>
		);
	}

	if (message.role === "assistant") {
		return (
			<div data-testid="assistant-message">
				{message.content.map((block, i) => {
					switch (block.type) {
						case "text":
							return <Markdown key={i} text={block.text} />;
						case "thinking":
							return <ThinkingBlock key={i} block={block} />;
						case "tool_call":
							return (
								<ToolCallBlock
									key={i}
									block={block}
									resultText={toolResults[block.toolCallId]}
								/>
							);
						case "image":
							return <ImageBlock key={i} block={block} />;
						default:
							return null;
					}
				})}
			</div>
		);
	}

	if (message.role === "tool_result") {
		const text = message.content
			.filter((b): b is PiTextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		return (
			<div className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400" data-testid="tool-result">
				<pre className="overflow-x-auto whitespace-pre-wrap break-all">{text}</pre>
			</div>
		);
	}

	// custom / compaction / 其他
	return (
		<div className="text-muted-foreground text-xs" data-testid="custom-message">
			[{message.kind}]
		</div>
	);
}
