import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ImagePlus } from "lucide-react";
import { PI_IMAGE_MIME_TYPES } from "@vcpdeck/shared";
import { Button } from "@/components/ui/button";
import type { PiSessionStatus } from "./use-pi-session.js";

/** 会话输入区的附件草稿；`id` 是跨上传完成仍稳定的身份，不能用文件名代替。 */
export interface PiChatAttachmentDraft {
	id: string;
	name: string;
	status: "uploading" | "ready" | "error";
	previewUrl?: string;
}

function isSupportedImage(type: string): boolean {
	return (PI_IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * 输入区：一体化 composer（正文 + 附件预览 + 底部操作行）。
 *
 * 发送语义（ADR-0035）：有文字或有已完成图片即可发送；纯图片发送空提示词，不补造任何文字。
 * 上传中/失败的草稿会阻止发送并给出提示，避免图片被静默丢掉。
 * `onSend` 返回 `false` 表示发送未被接受，此时保留草稿供重试。
 *
 * 参数控件（模型/思考/执行模式）由宿主经 `settingsSlot` 注入操作行，避免在输入框上方再堆一条设置栏。
 */
export function PiChatInput({
	status,
	disabled,
	composerClassName,
	sendPending = false,
	settingsSlot,
	onSend,
	onSteer,
	onFollowUp,
	onAbort,
	onCompact,
	onAbortCompact,
	attachments = [],
	attachmentError = null,
	onPickFiles,
	onRemoveAttachment,
}: {
	status: PiSessionStatus;
	disabled: boolean;
	composerClassName?: string;
	/** 上层有未完成的发送请求时禁止重复提交 */
	sendPending?: boolean;
	/** 注入到操作行的会话参数控件（模型/思考/执行模式） */
	settingsSlot?: ReactNode;
	/** 返回 `false` 表示未被接受，输入区保留草稿 */
	onSend: (prompt: string) => void | Promise<unknown>;
	onSteer: (message: string) => void | Promise<unknown>;
	onFollowUp: (message: string) => void | Promise<unknown>;
	onAbort: () => void;
	onCompact: () => void;
	onAbortCompact: () => void;
	/** 附件草稿（仅 idle prompt 可用） */
	attachments?: PiChatAttachmentDraft[];
	/** 上传前的本地校验错误（如数量/类型/体积） */
	attachmentError?: string | null;
	onPickFiles?: (files: File[]) => void;
	onRemoveAttachment?: (id: string) => void;
}) {
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"prompt" | "steer" | "followUp">("prompt");
	const [submitting, setSubmitting] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	const running = status === "running" || status === "waiting_input";
	const promptable = status === "idle" || status === "done";
	const readyDraftCount = attachments.filter((a) => a.status === "ready").length;
	const incompleteDraftCount = attachments.length - readyDraftCount;
	const canSend =
		!disabled &&
		promptable &&
		!sendPending &&
		!submitting &&
		incompleteDraftCount === 0 &&
		(text.trim().length > 0 || readyDraftCount > 0);

	const submit = async () => {
		if (!canSend) return;
		const value = text.trim();
		setSubmitting(true);
		try {
			const result =
				mode === "steer"
					? await onSteer(value)
					: mode === "followUp"
						? await onFollowUp(value)
						: await onSend(value);
			// 只有被接受才清空：被拒绝时保留草稿，避免用户以为发出去了。
			if (result !== false) setText("");
		} finally {
			setSubmitting(false);
		}
	};

	useEffect(() => {
		// Esc 仅在运行中 abort
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && running && !disabled) onAbort();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [running, disabled, onAbort]);

	/** 粘贴图片与选图共用上传入口；非图片内容一律不拦截。 */
	const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		if (disabled || !promptable || !onPickFiles || running) return;
		const items = Array.from(event.clipboardData?.items ?? []);
		const files = items
			.filter((item) => item.kind === "file" && isSupportedImage(item.type))
			.map((item) => item.getAsFile())
			.filter((file): file is File => file !== null);
		if (files.length === 0) return;
		event.preventDefault();
		onPickFiles(files);
	};

	return (
		<div
			className={composerClassName ?? "border-t border-border/70 bg-background/55 px-3 pb-3 pt-2 backdrop-blur"}
			data-testid="pi-chat-composer"
		>
			{running && !disabled && (
				<div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
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
			{/* 一体化 composer：正文与附件预览同属一块容器，操作行固定在底部 */}
			<div className="flex flex-col gap-1.5 rounded-2xl border border-border/80 bg-card/70 p-2.5 shadow-sm transition focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20">
				{attachments.length > 0 && (
					<div className="flex flex-wrap gap-1.5 px-0.5">
						{attachments.map((a) => (
							<span
								key={a.id}
								className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/60 py-1 pl-1.5 pr-1 text-[11px] text-muted-foreground"
								data-testid="pi-attachment-chip"
							>
								{a.previewUrl && a.status === "ready" ? (
									<img
										src={a.previewUrl}
										alt={`附件预览 ${a.name}`}
										className="h-6 w-6 rounded object-cover"
									/>
								) : (
									<span aria-hidden="true">
										{a.status === "uploading" ? "⏳" : a.status === "error" ? "❌" : "🖼️"}
									</span>
								)}
								<span className="max-w-40 truncate">{a.name}</span>
								{onRemoveAttachment && !disabled && promptable && (
									<button
										type="button"
										className="rounded px-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
										onClick={() => onRemoveAttachment(a.id)}
										aria-label={`移除附件 ${a.name}`}
										title={`移除附件 ${a.name}`}
									>
										✕
									</button>
								)}
							</span>
						))}
					</div>
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
									: "随便问问"
					}
					className="max-h-48 min-h-11 w-full resize-none bg-transparent px-1.5 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground/80 disabled:opacity-50"
					onChange={(e) => setText(e.target.value)}
					onPaste={handlePaste}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void submit();
						}
					}}
					aria-label="Pi 输入"
				/>
				{attachmentError && (
					<p role="alert" className="px-1.5 text-xs text-destructive">
						{attachmentError}
					</p>
				)}
				{incompleteDraftCount > 0 && promptable && (
					<p role="status" className="px-1.5 text-xs text-muted-foreground">
						{attachments.some((a) => a.status === "uploading")
							? "图片上传中，完成后即可发送。"
							: "有图片上传失败，请移除后重试。"}
					</p>
				)}
				<div className="flex min-w-0 items-center gap-1">
					{onPickFiles && !disabled && promptable && (
						<label
							className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground"
							title="添加图片"
						>
							<ImagePlus className="h-4 w-4" aria-hidden="true" />
							<span className="sr-only">添加图片</span>
							<input
								type="file"
								aria-label="添加图片"
								accept="image/png,image/jpeg,image/gif,image/webp"
								multiple
								className="hidden"
								disabled={disabled || running}
								onChange={(e) => {
									const files = Array.from(e.target.files ?? []);
									if (files.length > 0) onPickFiles(files);
									e.target.value = "";
								}}
							/>
						</label>
					)}
					{settingsSlot}
					<Button
						type="button"
						size="icon"
						className="ml-auto h-9 w-9 shrink-0 rounded-full shadow-sm"
						disabled={!canSend}
						onClick={() => void submit()}
						aria-label="发送"
						title={running ? "运行中" : "发送"}
					>
						<ArrowUp className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			</div>
		</div>
	);
}
