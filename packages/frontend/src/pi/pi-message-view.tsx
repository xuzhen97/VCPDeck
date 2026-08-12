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
	const [expanded, setExpanded] = useState(false);
	const label =
		typeof block.durationMs === "number"
			? `已思考 ${(block.durationMs / 1000).toFixed(1)} 秒`
			: "思考中…";
	const hasText = typeof block.text === "string" && block.text.length > 0;
	if (!hasText) {
		return (
			<div
				className="text-muted-foreground text-xs italic"
				data-testid="thinking-block"
			>
				{label}
			</div>
		);
	}
	return (
		<div
			className="my-2 overflow-hidden rounded-xl border border-border/70 bg-card/65 text-xs shadow-sm"
			data-testid="thinking-block"
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
					{block.text}
				</pre>
			)}
		</div>
	);
}

/** 图片占位（历史惰性加载，Task 13 接入短时 URL） */
function ImageBlock({
	block,
	onLoad,
	src,
}: {
	block: PiImagePlaceholder;
	onLoad?: (block: PiImagePlaceholder) => void;
	src?: string;
}) {
	if (src) {
		return (
			<img
				src={src}
				alt="历史图片"
				className="max-h-64 rounded"
				data-testid="loaded-image"
			/>
		);
	}
	return (
		<button
			type="button"
			className="text-xs text-blue-500 underline"
			data-testid="image-placeholder"
			onClick={() => onLoad?.(block)}
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
		<div
			className="my-2 overflow-hidden rounded-xl border border-border/70 bg-card/70 text-xs shadow-sm"
			data-testid="tool-call"
		>
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-secondary/45"
				onClick={() => setExpanded((v) => !v)}
			>
				<span className="shrink-0 rounded-full bg-primary/12 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary">
					{block.toolName}
				</span>
				<span className="min-w-0 truncate text-muted-foreground">
					{summarizeInput(block.input)}
				</span>
				<span className="ml-auto shrink-0 text-primary">
					{expanded ? "收起" : "展开"}
				</span>
			</button>
			{expanded && (
				<div className="pi-chat-fade-in border-t border-border/60 bg-background/40 px-3 py-2">
					{Object.keys(block.input).length > 0 && (
						<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-secondary/45 p-2 text-muted-foreground">
							{JSON.stringify(block.input, null, 2)}
						</pre>
					)}
					{resultText !== undefined && (
						<div className="mt-2 border-t border-border/60 pt-2">
							<div className="text-muted-foreground">结果</div>
							<pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-secondary/45 p-2 text-muted-foreground">
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

/** Tool Result：默认折叠，避免长输出挤占过程详情空间 */
function ToolResultBlock({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false);
	const lines = text.split(/\r?\n/);
	const firstLine = lines.find((line) => line.trim().length > 0)?.trim();
	const summary = firstLine
		? `${firstLine.slice(0, 100)}${firstLine.length > 100 ? "…" : ""}`
		: "无文本输出";

	return (
		<div
			className="overflow-hidden rounded-xl border border-border/70 bg-card/60 text-xs text-muted-foreground shadow-sm"
			data-testid="tool-result"
		>
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-secondary/45"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
			>
				<span className="shrink-0 font-semibold text-foreground">工具结果</span>
				<span className="shrink-0 text-muted-foreground">{lines.length} 行</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[11px]">
					{summary}
				</span>
				<span className="shrink-0 text-primary">
					{expanded ? "收起" : "展开"}
				</span>
			</button>
			{expanded && (
				<div className="pi-chat-fade-in border-t border-border/60 bg-background/35 p-2.5">
					<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-secondary/35 p-2">
						{text}
					</pre>
				</div>
			)}
		</div>
	);
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
	onImageLoad,
	imageUrls = {},
}: {
	message: PiMessage;
	/** toolCallId → Tool Result 文本（展开时显示） */
	toolResults?: Record<string, string>;
	/** 历史图片惰性加载（Task 13） */
	onImageLoad?: (block: PiImagePlaceholder) => void;
	/** 已加载的历史图片（key: `${entryId}:${blockIndex}` → data URL） */
	imageUrls?: Record<string, string>;
}) {
	if (message.role === "user") {
		return (
			<div
				className="rounded-2xl bg-gradient-to-br from-primary to-primary/80 px-3.5 py-2.5 text-primary-foreground shadow-lg shadow-primary/20"
				data-testid="user-message"
			>
				{message.content.map((block, i) => {
					if (block.type === "text")
						return <Markdown key={i} text={block.text} />;
					if (block.type === "image")
						return (
							<ImageBlock
								key={i}
								block={block}
								onLoad={onImageLoad}
								src={imageUrls[`${block.entryId}:${block.blockIndex}`]}
							/>
						);
					return null;
				})}
			</div>
		);
	}

	if (message.role === "assistant") {
		return (
			<div
				className="rounded-2xl border border-border/70 bg-card/70 px-3.5 py-2.5 shadow-sm backdrop-blur"
				data-testid="assistant-message"
			>
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
							return (
								<ImageBlock
									key={i}
									block={block}
									onLoad={onImageLoad}
									src={imageUrls[`${block.entryId}:${block.blockIndex}`]}
								/>
							);
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
		return <ToolResultBlock text={text} />;
	}

	// custom / compaction / 其他
	return (
		<div className="text-muted-foreground text-xs" data-testid="custom-message">
			[{message.kind}]
		</div>
	);
}
