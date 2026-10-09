import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
	ClientInfo,
	PiAttachmentRef,
	PiCapabilityStatus,
	PiCwdRef,
	PiImagePlaceholder,
	PiModelInfo,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { uploadFile } from "@/api/upload-file";
import { Drawer } from "@/components/ui/drawer";
import { PiSessionSidebar } from "../pi/pi-session-sidebar.js";
import { PiChatWindow } from "../pi/pi-chat-window.js";
import { PiChatInput, type PiChatAttachmentDraft } from "../pi/pi-chat-input.js";
import { PiExtensionStatus } from "../pi/pi-extension-status.js";
import { PiRunDetails, THINKING_OPTIONS } from "../pi/pi-run-details.js";
import { PiAuditPanel } from "../pi/pi-audit-panel.js";
import { PiExtensionDialog } from "../pi/pi-extension-dialog.js";
import { usePiSession, type PiThinkingSelection } from "../pi/use-pi-session.js";
import { setPiThinkingLoader } from "../pi/pi-thinking-loader.js";
import type { PiToolExecutionMode, PiSessionSnapshot } from "@vcpdeck/shared";
import {
	MAX_PI_IMAGE_BYTES,
	MAX_PI_IMAGES_PER_PROMPT,
	MAX_PI_IMAGES_TOTAL_BYTES,
	PI_IMAGE_MIME_TYPES,
} from "@vcpdeck/shared";

/** 附件草稿：`id` 稳定跨上传完成，`ref` 是服务端确认的短期引用。 */
type AttachmentDraft = PiChatAttachmentDraft & { ref?: PiAttachmentRef; size: number };

/** 上传前的本地校验；返回错误文案或 null。都使用与 Server 相同的上限（ADR-0035）。 */
function validateAttachments(
	existing: AttachmentDraft[],
	files: File[],
): string | null {
	if (existing.length + files.length > MAX_PI_IMAGES_PER_PROMPT) {
		return `一次最多 ${MAX_PI_IMAGES_PER_PROMPT} 张图片。`;
	}
	for (const file of files) {
		if (!(PI_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
			return "仅支持 PNG、JPEG、GIF、WebP 图片。";
		}
		if (file.size > MAX_PI_IMAGE_BYTES) {
			return "单张图片不能超过 10 MiB。";
		}
	}
	const total = [...existing.map((draft) => draft.size ?? 0), ...files.map((file) => file.size)];
	if (total.reduce((sum, size) => sum + size, 0) > MAX_PI_IMAGES_TOTAL_BYTES) {
		return "图片总量不能超过 100 MiB。";
	}
	return null;
}

/**
 * Agent 布局的会话参数控件：模型、思考等级、执行模式的紧凑内联版本，
 * 直接放进 composer 操作行，不再单独占一条设置栏。
 *
 * 语义与右栏 PiRunDetails 完全一致：只在 Owner 且会话空闲时可用；执行模式菜单展示服务端确认的
 * 有效值与来源，`profile` 表示清除本会话覆盖、动态跟随当前绑定 Profile。
 * 参数名仅保留给无障碍层（aria-label），避免重复文字噪声。
 */
function AgentSessionSettings({
	snapshot: snapshot,
	models,
	model,
	thinkingSelection,
	disabled,
	onModelChange,
	onThinkingChange,
	onExecutionModeChange,
}: {
	snapshot: PiSessionSnapshot | null;
	models: PiModelInfo[];
	model: PiModelInfo | null;
	thinkingSelection: PiThinkingSelection;
	disabled: boolean;
	onModelChange: (provider: string, modelId: string) => void;
	onThinkingChange: (level: PiThinkingSelection) => void;
	onExecutionModeChange: (mode: PiToolExecutionMode | null) => void;
}) {
	const mode = snapshot?.effectiveExecutionMode;
	const modelValue = model ? `${model.provider}\u0000${model.modelId}` : "";
	const compactSelect =
		"h-8 max-w-32 truncate rounded-lg border-0 bg-transparent px-1 text-xs text-muted-foreground outline-none transition hover:bg-secondary/70 focus:bg-secondary/70 disabled:opacity-50";
	return <div
		className="flex min-w-0 items-center gap-0.5"
		data-testid="agent-session-settings"
	>
		<select
			aria-label="会话模型"
			className={`${compactSelect} max-w-40`}
			disabled={disabled || !snapshot?.isOwner || models.length === 0}
			value={modelValue}
			onChange={(event) => {
				const [provider, modelId] = event.target.value.split("\u0000");
				if (provider && modelId) onModelChange(provider, modelId);
			}}
		>
			{/* 无候选时必须给出可见文案，否则空下拉框看起来像界面坏了。 */}
			{models.length === 0 && <option value={modelValue}>{model ? `${model.provider} / ${model.modelId}` : "（暂无可用模型）"}</option>}
			{models.map((item) => <option key={`${item.provider}\u0000${item.modelId}`} value={`${item.provider}\u0000${item.modelId}`}>{item.provider} / {item.modelId}</option>)}
		</select>
		<select
			aria-label="会话思考等级"
			className={compactSelect}
			disabled={disabled || !snapshot?.isOwner}
			value={thinkingSelection}
			onChange={(event) => onThinkingChange(event.target.value as PiThinkingSelection)}
		>
			{THINKING_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
		</select>
		<select
			aria-label="会话执行模式"
			className={compactSelect}
			value={snapshot?.executionModeOverride ?? "profile"}
			disabled={disabled || !snapshot?.isOwner || !mode}
			onChange={(event) => onExecutionModeChange(event.target.value === "profile" ? null : event.target.value as PiToolExecutionMode)}
		>
			<option value="profile">跟随 Profile{mode ? ` · ${mode}` : " · 未知"}</option>
			<option value="supervised">监督模式</option>
			<option value="automatic">自动执行</option>
		</select>
		{mode === "automatic" && (
			<span
				role="status"
				className="shrink-0 text-xs text-muted-foreground"
				title="自动执行不会再逐次询问，但工具仍限于当前 Runtime 已注册/加载的集合，并受操作系统权限限制。"
			>
				自动执行：已注册工具直接运行，不再逐次询问。
			</span>
		)}
	</div>;
}

/**
 * 机器工作区 / Agent 对话视图：三栏 IDE 布局（左项目/会话、中对话、右详情）。
 *
 * `leftSlot` 供宿主在左栏顶部注入上下文选择器（如 Agent 模块的机器选择器）；
 * 不传时行为与改动前完全一致。
 */
export function PiPanel({
	client,
	leftSlot,
	agentChatLayout = false,
}: {
	client: ClientInfo;
	leftSlot?: ReactNode;
	agentChatLayout?: boolean;
}) {
	const sdk = useSdk();
	const capability: PiCapabilityStatus | null = useMemo(() => {
		const pi = client.capabilityDetails?.pi;
		return pi ?? null;
	}, [client]);

	const [cwdRef, setCwdRef] = useState<PiCwdRef | null>(null);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [info, setInfo] = useState<{
		id: string;
		name: string;
		firstMessage: string | null;
	} | null>(null);
	const [leftOpen, setLeftOpen] = useState(false);
	const [rightOpen, setRightOpen] = useState(false);
	const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
	/** 草稿列表的逻辑权威：ref 同步更新，避免陈旧闭包把晚到结果写错上下文。 */
	const attachmentsRef = useRef<AttachmentDraft[]>([]);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [loadedImages, setLoadedImages] = useState<Record<string, string>>({});
	const [sessionError, setSessionError] = useState<string | null>(null);
	const contextGeneration = useRef(0);

	const { state, actions } = usePiSession(sdk.pi);

	const mutateAttachments = useCallback(
		(fn: (current: AttachmentDraft[]) => AttachmentDraft[]) => {
			const next = fn(attachmentsRef.current);
			attachmentsRef.current = next;
			setAttachments(next);
		},
		[],
	);

	const revokeDrafts = useCallback((drafts: AttachmentDraft[]) => {
		for (const draft of drafts) {
			if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
		}
	}, []);

	const clearAttachments = useCallback(() => {
		revokeDrafts(attachmentsRef.current);
		mutateAttachments(() => []);
		setAttachmentError(null);
	}, [mutateAttachments, revokeDrafts]);

	const removeAttachment = useCallback(
		(id: string) => {
			const target = attachmentsRef.current.find((item) => item.id === id);
			if (target) revokeDrafts([target]);
			mutateAttachments((current) => current.filter((item) => item.id !== id));
			setAttachmentError(null);
		},
		[mutateAttachments, revokeDrafts],
	);

	// 卸载时释放对象 URL，避免草稿预览泄漏。
	useEffect(
		() => () => revokeDrafts(attachmentsRef.current),
		[revokeDrafts],
	);

	const openSession = useCallback(
		async (sid: string, project: PiCwdRef) => {
			const generation = ++contextGeneration.current;
			setCwdRef(project);
			setSessionId(sid);
			setInfo(null);
			setSessionError(null);
			clearAttachments();
			setLoadedImages({});
			try {
				await actions.openSession(client.clientId, sid, project);
				const detail = (await sdk.pi.sessions.get(client.clientId, sid, project)) as {
					info: { id: string; name: string; firstMessage: string | null };
				};
				if (contextGeneration.current !== generation) return;
				setInfo(detail.info);
				setLeftOpen(false);
			} catch (cause) {
				if (contextGeneration.current !== generation) return;
				setInfo(null);
				setSessionError(cause instanceof Error ? cause.message : "打开会话失败");
			}
		},
		[actions, client.clientId, sdk.pi],
	);

	const handleCreated = useCallback(
		(sid: string, project: PiCwdRef) => { void openSession(sid, project); },
		[openSession],
	);

	const handleCwdChange = useCallback(
		(ref: PiCwdRef) => {
			contextGeneration.current++;
			setCwdRef(ref);
			setSessionId(null);
			setInfo(null);
			setSessionError(null);
			clearAttachments();
			setLoadedImages({});
			actions.close();
		},
		[actions, clearAttachments],
	);

	/** 删除当前 active session 后：清空所有会话绑定状态，关闭事件流。cwd 不动。 */
	const handleDeselect = useCallback(() => {
		contextGeneration.current++;
		setSessionId(null);
		setInfo(null);
		setSessionError(null);
		clearAttachments();
		setLoadedImages({});
		actions.reset();
		actions.close();
	}, [actions, clearAttachments]);

	const handleSelectSession = useCallback(
		(sid: string | null, project?: PiCwdRef) => {
			if (sid === null) handleDeselect();
			else if (project) void openSession(sid, project);
			else if (cwdRef) void openSession(sid, cwdRef);
		},
		[handleDeselect, openSession, cwdRef],
	);

	/** 选图 → create upload → XHR PUT → complete → refs */
	/** 选图/粘贴共用：本地校验 → create upload → XHR PUT → complete → 写入草稿 */
	const handlePickFiles = useCallback(
		(files: File[]) => {
			const invalid = validateAttachments(attachmentsRef.current, files);
			if (invalid) {
				setAttachmentError(invalid);
				return;
			}
			setAttachmentError(null);
			const pending: AttachmentDraft[] = files.map((file) => ({
				id: crypto.randomUUID(),
				name: file.name,
				status: "uploading" as const,
				size: file.size,
				previewUrl: URL.createObjectURL(file),
			}));
			mutateAttachments((current) => [...current, ...pending]);
			// 各文件并行上传：一张图卡住不应阻塞其余图片。
			for (const [index, file] of files.entries()) {
				const draft = pending[index]!;
				void (async () => {
					try {
						const [session] = (await sdk.pi.attachments.create(client.clientId, [
							{
								filename: file.name,
								size: file.size,
								mimeType: file.type || "image/png",
							},
						])) as Array<{
							fileId: string;
							uploadUrl: string;
							expiresAt: number;
						}>;
						if (!session) throw new Error("create failed");
						await uploadFile(session.uploadUrl, file);
						const ref = (await sdk.pi.attachments.complete(
							client.clientId,
							session.fileId,
						)) as PiAttachmentRef;
						// 只写入仍在列表中的 id：切会话/移除草稿后列表已无该 id，晚到结果自然丢弃。
						mutateAttachments((current) =>
							current.map((item) =>
								item.id === draft.id
									? { ...item, status: "ready" as const, ref }
									: item,
							),
						);
					} catch {
						mutateAttachments((current) =>
							current.map((item) =>
								item.id === draft.id
									? { ...item, status: "error" as const }
									: item,
							),
						);
					}
				})();
			}
		},
		[client.clientId, mutateAttachments, sdk.pi],
	);

	/** 历史图片惰性加载（entryContent → data URL） */
	const handleImageLoad = useCallback(
		async (block: PiImagePlaceholder) => {
			if (!cwdRef || !sessionId) return;
			try {
				const content = (await sdk.pi.sessions.entryContent(
					client.clientId,
					sessionId,
					block.entryId,
					cwdRef,
					block.blockIndex,
				)) as { mimeType: string; data: string };
				setLoadedImages((prev) => ({
					...prev,
					[`${block.entryId}:${block.blockIndex}`]: `data:${content.mimeType};base64,${content.data}`,
				}));
			} catch {
				// 忽略：图片过期或不可用
			}
		},
		[sdk.pi, client.clientId, cwdRef, sessionId],
	);

	/**
	 * 历史 thinking 惰性加载：pi-web 渲染层的思考块展开时经注入点取正文。
	 * 只在用户展开某个思考块时触发一次 IPC，带缓存（失败不入缓存，可重试）。
	 */
	useEffect(() => {
		if (!cwdRef || !sessionId) {
			setPiThinkingLoader(null);
			return;
		}
		const clientId = client.clientId;
		const cache = new Map<string, Promise<string>>();
		setPiThinkingLoader(async (targetSessionId, entryId, blockIndex) => {
			const key = `${targetSessionId}:${entryId}:${blockIndex}`;
			const cached = cache.get(key);
			if (cached) return cached;
			const request = sdk.pi.sessions
				.entryContent(clientId, targetSessionId, entryId, cwdRef, blockIndex)
				.then((raw) => {
					const thinking = (raw as { thinking?: unknown } | null)?.thinking;
					if (typeof thinking !== "string") {
						throw new Error("thinking unavailable");
					}
					return thinking;
				});
			cache.set(key, request);
			request.catch(() => cache.delete(key));
			return request;
		});
		return () => setPiThinkingLoader(null);
	}, [sdk.pi, client.clientId, cwdRef, sessionId]);

	/** 文件 API 注入会话侧栏；仅依赖 sdk，必须置于条件早返回之前以保证 hook 顺序稳定 */
	const filesApi = useMemo(
		() => ({
			roots: (clientId: string, signal?: AbortSignal) =>
				sdk.files.roots(clientId, signal),
			list: (
				clientId: string,
				rootDir: string,
				path: string,
				signal?: AbortSignal,
			) => sdk.files.list(clientId, rootDir, path, signal),
		}),
		[sdk],
	);

	// 不可用态
	if (capability && !capability.available) {
		return (
			<div className="space-y-3 p-4">
				<div className="rounded border border-border p-4 text-sm">
					<div className="font-medium">Pi 不可用</div>
					<div className="mt-1 text-xs text-muted-foreground">
						原因：{capability.code} — {capability.message}
					</div>
					{capability.nodeVersion && (
						<div className="mt-1 text-xs text-muted-foreground">
							检测到 Node {capability.nodeVersion}
						</div>
					)}
				</div>
			</div>
		);
	}
	if (capability === null) {
		return (
			<div className="space-y-3 p-4">
				<div className="rounded border border-border p-4 text-sm">
					<div className="font-medium">Pi 不可用</div>
					<div className="mt-1 text-xs text-muted-foreground">
						原因：PI_CLIENT_UNSUPPORTED — 此 Client 版本不支持 Pi
					</div>
				</div>
			</div>
		);
	}

	const isObserver = state.snapshot?.isOwner === false;
	const settingsDisabled =
		!sessionId ||
		isObserver ||
		state.status !== "idle" ||
		state.agentState?.status !== "idle";
	// 只要当前身份是 owner，就视同本 cwd 下所有会话都可管理。
	// 错误语义：该 cwd 下所有 session 都标记为可改 / 可删。
	const mutableSessionIds = isObserver
		? new Set<string>()
		: new Set<string>(["*"]);

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<div className="flex min-h-0 flex-1 gap-3">
				{/* 左栏：桌面常驻（Agent 宽屏为项目导航器），窄屏由抽屉提供 */}
				<aside
					aria-label="项目与会话"
					className={agentChatLayout ? "hidden w-72 shrink-0 lg:block" : "hidden w-72 shrink-0 overflow-y-auto rounded border border-border p-3 lg:block"}
					data-testid="pi-left-panel"
				>
					{agentChatLayout ? (
						// 不套卡片：Agent 宽屏下项目/会话就是一块平整导航，跟左侧全局导航视觉相连。
						<div className="hidden h-full min-h-0 flex-col gap-2 overflow-y-auto border-r border-border/60 px-3 py-3 lg:flex">
							{leftSlot}
							<PiSessionSidebar
								pi={sdk.pi} files={filesApi} clientId={client.clientId} cwdRef={cwdRef}
								onCwdChange={handleCwdChange} activeSessionId={sessionId} mutableSessionIds={mutableSessionIds}
								onSelectSession={(sid, project) => handleSelectSession(sid, project ?? cwdRef ?? undefined)}
								onCreated={(sid, project) => { const target = project ?? cwdRef; if (target) handleCreated(sid, target); }}
								agentChatLayout
							/>
						</div>
					) : (
						<>
							{leftSlot}
							<PiSessionSidebar
								pi={sdk.pi} files={filesApi} clientId={client.clientId} cwdRef={cwdRef}
								onCwdChange={handleCwdChange} activeSessionId={sessionId} mutableSessionIds={mutableSessionIds}
								onSelectSession={(sid) => handleSelectSession(sid)}
								onCreated={(sid) => { if (cwdRef) handleCreated(sid, cwdRef); }}
							/>
						</>
					)}
				</aside>

				{/* 中栏：对话时间线 */}
				<main
					aria-label="Pi 对话"
					className={agentChatLayout ? "flex min-h-0 min-w-0 flex-1 flex-col" : "flex min-h-0 min-w-0 flex-1 flex-col rounded border border-border"}
					data-testid="pi-center-panel"
				>
					{agentChatLayout ? (
						<div className="flex min-h-0 flex-1 flex-col">
							{sessionId ? (
								<>
									<div className="flex items-center gap-2 border-b border-border/60 px-5 py-2.5">
										<p className="min-w-0 flex-1 truncate text-sm font-medium">
											{info?.name || info?.firstMessage || "新会话"}
										</p>
										<span className="shrink-0 text-xs text-muted-foreground">
											{cwdRef?.relativePath || cwdRef?.rootDir}
										</span>
									</div>
									<PiChatWindow state={state} info={info} hideSessionTitle sessionId={sessionId} onLoadMore={() => void actions.loadMore()} onImageLoad={(block) => void handleImageLoad(block)} imageUrls={loadedImages} />
								</>
							) : (
								<div className="m-auto flex flex-col items-center gap-2 px-6 text-center">
									<p className="text-base font-medium">选择一个项目开始</p>
									<p className="max-w-sm text-sm text-muted-foreground">
										从左侧选择项目，或新建任务；项目与会话都在目标机器上。
									</p>
								</div>
							)}
						</div>
					) : (
						<div className="min-h-0 flex-1"><PiChatWindow state={state} info={info} sessionId={sessionId} onLoadMore={() => { if (cwdRef && sessionId) void actions.loadMore(); }} onImageLoad={(block) => void handleImageLoad(block)} imageUrls={loadedImages} /></div>
					)}
					{sessionError && <p role="alert" className="px-5 text-sm text-destructive">{sessionError}</p>}
					{/* 扩展持续 UI 状态（status/widget/title）：纯文本展示，不执行 HTML。
					    上/下分区由组件内按 placement 标注，便于后续拆分到 Composer 上下。 */}
					<div className="px-5">
						<PiExtensionStatus snapshot={state.extensionUi} />
					</div>
					<PiChatInput
						/* 上下文变化时重挂载：草稿文本与 prompt/steer/followUp 模式属于单个会话，
						   否则切项目/会话后残留草稿会被发到错误的会话。 */
						key={`${client.clientId}\u0000${cwdRef?.rootDir ?? ""}\u0000${cwdRef?.relativePath ?? ""}\u0000${sessionId ?? "none"}`}
						status={state.status}
						composerClassName={agentChatLayout ? "mx-auto w-full max-w-4xl px-5 pb-5" : undefined}
						disabled={!cwdRef || !sessionId || isObserver}
						sendPending={sending}
						{...(agentChatLayout
							? {
									settingsSlot: (
										<AgentSessionSettings
											snapshot={state.snapshot}
											models={state.models}
											model={state.agentState?.model ?? null}
											thinkingSelection={state.thinkingSelection}
											disabled={settingsDisabled || state.status === "disconnected"}
											onModelChange={(provider, modelId) => void actions.setModel(provider, modelId)}
											onThinkingChange={(level) => void actions.setThinking(level)}
											onExecutionModeChange={(mode) => void actions.setExecutionMode(mode)}
										/>
									),
								}
							: {})}
						commands={state.commands?.commands ?? []}
						onCommand={async (name, args) => {
							// 未知命令返回 rejected（Server/Client 明确拒绝），
							// Composer 据此保留草稿，绝不退化为普通 Prompt。
							return (await actions.command(name, args)) !== "rejected";
						}}
						editorRequest={state.editorRequest}
						onApplyEditorRequest={(requestId) =>
							actions.dismissEditorRequest(requestId)
						}
						onDismissEditorRequest={(requestId) =>
							actions.dismissEditorRequest(requestId)
						}
						/* 错误态输入框禁用，入口不能只藏在右栏抽屉里；仅会话属主可用。 */
						attachments={attachments.map((a) => ({
							id: a.id,
							name: a.name,
							status: a.status,
							...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
						}))}
						attachmentError={attachmentError}
						onPickFiles={handlePickFiles}
						onRemoveAttachment={removeAttachment}
						onSend={async (prompt) => {
							const refs = attachmentsRef.current
								.filter((a) => a.status === "ready" && a.ref)
								.map((a) => a.ref!);
							setSending(true);
							try {
								const result = await actions.send({
									prompt,
									...(refs.length > 0 ? { images: refs } : {}),
								});
								// 只有被接受才丢弃草稿；被拒时保留，让用户能重试。
								if (result !== "accepted") return false;
								clearAttachments();
								return true;
							} finally {
								setSending(false);
							}
						}}
						onSteer={(message) => void actions.steer(message)}
						onFollowUp={(message) => void actions.followUp(message)}
						onAbort={() => void actions.abort()}
						onCompact={() => void actions.compact()}
						onAbortCompact={() => void actions.abortCompact()}
					/>
				</main>

				{/* 右栏：桌面常驻，窄屏抽屉 */}
				<aside
					aria-label="运行详情"
					className={agentChatLayout ? "hidden" : "hidden w-80 shrink-0 overflow-y-auto rounded border border-border p-3 xl:block 2xl:w-96"}
					data-testid="pi-right-panel"
				>
					<PiRunDetails
						snapshot={state.snapshot ?? null}
						status={state.status}
						agentState={state.agentState}
						models={state.models}
						thinkingSelection={state.thinkingSelection}
						disabled={settingsDisabled}
						onModelChange={(provider, modelId) =>
							void actions.setModel(provider, modelId)
						}
						onThinkingChange={(level) => void actions.setThinking(level)}
						onArchive={() => void actions.archive()}
						onRestore={() => void actions.restore()}
					/>
					{sessionId ? (
						<PiAuditPanel
							clientId={client.clientId}
							sessionId={sessionId}
							pi={sdk.pi}
						/>
					) : null}
				</aside>
			</div>

			{/* 窄屏：左/右抽屉开关 */}
			<div className="flex gap-2">
				<button
					type="button"
					className="rounded border border-border px-2 py-1 text-xs lg:hidden"
					onClick={() => setLeftOpen(true)}
				>
					项目与会话
				</button>
				<button
					type="button"
					className={`rounded border border-border px-2 py-1 text-xs ${agentChatLayout ? "" : "xl:hidden"}`}
					onClick={() => setRightOpen(true)}
				>
					详情
				</button>
			</div>
			<Drawer
				open={leftOpen}
				onClose={() => setLeftOpen(false)}
				title="项目与会话"
				side="left"
			>
				{/* 关闭时条件渲染：抽屉只做位移隐藏，无条件渲染会让导航器与输入控件重复挂载。 */}
				{leftOpen && <div className="flex min-h-0 flex-1 flex-col">
					{leftSlot}
					<PiSessionSidebar
						pi={sdk.pi} files={filesApi} clientId={client.clientId} cwdRef={cwdRef}
						onCwdChange={handleCwdChange} activeSessionId={sessionId} mutableSessionIds={mutableSessionIds}
						onSelectSession={(sid, project) => handleSelectSession(sid, project ?? cwdRef ?? undefined)}
						onCreated={(sid, project) => { const target = project ?? cwdRef; if (target) handleCreated(sid, target); }} agentChatLayout={agentChatLayout}
					/>
				</div>}
			</Drawer>
			<Drawer
				open={rightOpen}
				onClose={() => setRightOpen(false)}
				title="运行详情"
			>
				<PiRunDetails
					snapshot={state.snapshot ?? null}
					status={state.status}
					agentState={state.agentState}
					models={state.models}
					thinkingSelection={state.thinkingSelection}
					disabled={settingsDisabled}
					onModelChange={(provider, modelId) =>
						void actions.setModel(provider, modelId)
					}
					onThinkingChange={(level) => void actions.setThinking(level)}
					onArchive={() => void actions.archive()}
					onRestore={() => void actions.restore()}
				/>
			</Drawer>

			{state.pendingExtension && (
				<PiExtensionDialog
					request={state.pendingExtension}
					disabled={isObserver}
					onRespond={(value, confirmed) =>
						void actions.extensionResponse(
							state.pendingExtension!.requestId,
							value,
							confirmed,
						)
					}
					onCancel={() => {
						const pending = state.pendingExtension!;
						// confirm 取消 = 拒绝（confirmed:false）；其他类型取消 = cancelled:true
						void actions.extensionResponse(
							pending.requestId,
							undefined,
							pending.kind === "confirm" ? false : undefined,
							pending.kind === "confirm" ? undefined : true,
						);
					}}
				/>
			)}
		</div>
	);
}
