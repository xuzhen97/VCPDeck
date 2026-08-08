import { useCallback, useMemo, useState } from "react";
import type {
	ClientInfo,
	PiAttachmentRef,
	PiCapabilityStatus,
	PiCwdRef,
	PiImagePlaceholder,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { uploadFile } from "@/api/upload-file";
import { Drawer } from "@/components/ui/drawer";
import { PiSessionSidebar } from "../pi/pi-session-sidebar.js";
import { PiChatWindow } from "../pi/pi-chat-window.js";
import { PiChatInput } from "../pi/pi-chat-input.js";
import { PiRunDetails } from "../pi/pi-run-details.js";
import { PiExtensionDialog } from "../pi/pi-extension-dialog.js";
import { usePiSession } from "../pi/use-pi-session.js";

/** 高权限告警（cwd 不是沙箱） */
function RiskBanner() {
	return (
		<div
			role="note"
			className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400"
		>
			Pi 继承远程机器的用户权限：工作目录不是沙箱，项目扩展可执行任意代码。
		</div>
	);
}

/** 机器工作区 Pi Tab：三栏 IDE 布局（左项目/会话、中对话、右详情） */
export function PiPanel({ client }: { client: ClientInfo }) {
	const sdk = useSdk();
	const capability: PiCapabilityStatus | null = useMemo(() => {
		const pi = client.capabilityDetails?.pi;
		return pi ?? null;
	}, [client]);

	const [cwdRef, setCwdRef] = useState<PiCwdRef | null>(null);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [info, setInfo] = useState<{ id: string; name: string; firstMessage: string | null } | null>(null);
	const [leftOpen, setLeftOpen] = useState(false);
	const [rightOpen, setRightOpen] = useState(false);
	const [attachments, setAttachments] = useState<
		Array<{ name: string; status: "uploading" | "ready" | "error"; ref?: PiAttachmentRef }>
	>([]);
	const [loadedImages, setLoadedImages] = useState<Record<string, string>>({});

	const { state, actions } = usePiSession(sdk.pi);

	const openSession = useCallback(
		async (sid: string) => {
			if (!cwdRef) return;
			setSessionId(sid);
			await actions.openSession(client.clientId, sid, cwdRef);
			try {
				const detail = (await sdk.pi.sessions.get(client.clientId, sid, cwdRef)) as {
					info: { id: string; name: string; firstMessage: string | null };
				};
				setInfo(detail.info);
			} catch {
				setInfo(null);
			}
		},
		[actions, cwdRef, client.clientId, sdk.pi],
	);

	const handleCreated = useCallback(
		(sid: string) => {
			setSessionId(sid);
			void openSession(sid);
			setLeftOpen(false);
		},
		[openSession],
	);

	const handleCwdChange = useCallback(
		(ref: PiCwdRef) => {
			setCwdRef(ref);
			setSessionId(null);
			setInfo(null);
			setAttachments([]);
			setLoadedImages({});
			actions.close();
		},
		[actions],
	);

	/** 选图 → create upload → XHR PUT → complete → refs */
	const handlePickFiles = useCallback(
		async (files: FileList) => {
			const list = Array.from(files);
			if (attachments.length + list.length > 10) return;
			const pending = list.map((f) => ({ name: f.name, status: "uploading" as const }));
			setAttachments((prev) => [...prev, ...pending]);
			for (const file of list) {
				try {
					const [session] = (await sdk.pi.attachments.create(client.clientId, [
						{ filename: file.name, size: file.size, mimeType: file.type || "image/png" },
					])) as Array<{ fileId: string; uploadUrl: string; expiresAt: number }>;
					if (!session) throw new Error("create failed");
					await uploadFile(session.uploadUrl, file);
					const ref = (await sdk.pi.attachments.complete(
						client.clientId,
						session.fileId,
					)) as PiAttachmentRef;
					setAttachments((prev) =>
						prev.map((a) =>
							a.name === file.name && a.status === "uploading"
								? { name: a.name, status: "ready" as const, ref }
								: a,
						),
					);
				} catch {
					setAttachments((prev) =>
						prev.map((a) =>
							a.name === file.name ? { name: a.name, status: "error" as const } : a,
						),
					);
				}
			}
		},
		[attachments.length, client.clientId, sdk.pi],
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

	// 不可用态
	if (capability && !capability.available) {
		return (
			<div className="space-y-3 p-4">
				<RiskBanner />
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
				<RiskBanner />
				<div className="rounded border border-border p-4 text-sm">
					<div className="font-medium">Pi 不可用</div>
					<div className="mt-1 text-xs text-muted-foreground">
						原因：PI_CLIENT_UNSUPPORTED — 此 Client 版本不支持 Pi
					</div>
				</div>
			</div>
		);
	}

	const isObserver = false; // 首版单用户环境无多身份；Owner 语义由 Server 保证
	const settingsDisabled =
		!sessionId || state.status !== "idle" || state.agentState?.status !== "idle";

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

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<RiskBanner />
			<div className="flex min-h-0 flex-1 gap-3">
				{/* 左栏：桌面常驻，窄屏抽屉 */}
				<aside
					aria-label="项目与会话"
					className="hidden w-72 shrink-0 overflow-y-auto rounded border border-border p-3 lg:block"
					data-testid="pi-left-panel"
				>
					<PiSessionSidebar
						pi={sdk.pi}
						files={filesApi}
						clientId={client.clientId}
						cwdRef={cwdRef}
						onCwdChange={handleCwdChange}
						activeSessionId={sessionId}
						onSelectSession={(sid) => void openSession(sid)}
						onCreated={handleCreated}
					/>
				</aside>

				{/* 中栏：对话时间线 */}
				<main
					aria-label="Pi 对话"
					className="flex min-h-0 min-w-0 flex-1 flex-col rounded border border-border"
					data-testid="pi-center-panel"
				>
					<div className="min-h-0 flex-1">
						<PiChatWindow
							state={state}
							info={info}
							onLoadMore={() => {
								if (cwdRef && sessionId && state.nextCursor) {
									void sdk.pi.sessions
										.context(client.clientId, sessionId, cwdRef, {
												cursor: state.nextCursor,
											})
										.then((page) => {
											// 追加更早消息（简化：交给 reconcile 轮询）
											void page;
										})
										.catch(() => {});
								}
							}}
							onImageLoad={(block) => void handleImageLoad(block)}
							imageUrls={loadedImages}
						/>
					</div>
					<PiChatInput
						status={state.status}
						disabled={!cwdRef || !sessionId}
						attachments={attachments.map((a) => ({ name: a.name, status: a.status }))}
						onPickFiles={(files) => void handlePickFiles(files)}
						onRemoveAttachment={(index) =>
							setAttachments((prev) => prev.filter((_, i) => i !== index))
						}
						onSend={(prompt) => {
							const refs = attachments
								.filter((a) => a.status === "ready" && a.ref)
								.map((a) => a.ref!);
							setAttachments([]);
							void actions.send({ prompt, images: refs.length > 0 ? refs : undefined });
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
					className="hidden w-80 shrink-0 overflow-y-auto rounded border border-border p-3 lg:block"
					data-testid="pi-right-panel"
				>
					<PiRunDetails
						agentState={state.agentState}
						runId={state.runId}
						sessionId={sessionId}
						ownerName={null}
						isObserver={isObserver}
						models={state.models}
						thinkingSelection={state.thinkingSelection}
						disabled={settingsDisabled}
						onModelChange={(provider, modelId) => void actions.setModel(provider, modelId)}
						onThinkingChange={(level) => void actions.setThinking(level)}
					/>
				</aside>
			</div>

			{/* 窄屏：左/右抽屉开关 */}
			<div className="flex gap-2 lg:hidden">
				<button
					type="button"
					className="rounded border border-border px-2 py-1 text-xs"
					onClick={() => setLeftOpen(true)}
				>
					项目与会话
				</button>
				<button
					type="button"
					className="rounded border border-border px-2 py-1 text-xs"
					onClick={() => setRightOpen(true)}
				>
					详情
				</button>
			</div>
			<Drawer open={leftOpen} onClose={() => setLeftOpen(false)} title="项目与会话" side="left">
				<PiSessionSidebar
					pi={sdk.pi}
					files={filesApi}
					clientId={client.clientId}
					cwdRef={cwdRef}
					onCwdChange={handleCwdChange}
					activeSessionId={sessionId}
					onSelectSession={(sid) => void openSession(sid)}
					onCreated={handleCreated}
				/>
			</Drawer>
			<Drawer open={rightOpen} onClose={() => setRightOpen(false)} title="运行详情">
				<PiRunDetails
					agentState={state.agentState}
					runId={state.runId}
					sessionId={sessionId}
					ownerName={null}
					isObserver={isObserver}
					models={state.models}
					thinkingSelection={state.thinkingSelection}
					disabled={settingsDisabled}
					onModelChange={(provider, modelId) => void actions.setModel(provider, modelId)}
					onThinkingChange={(level) => void actions.setThinking(level)}
				/>
			</Drawer>

			{state.pendingExtension && (
				<PiExtensionDialog
					request={state.pendingExtension}
					disabled={false}
					onRespond={(value, confirmed) =>
						void actions.extensionResponse(state.pendingExtension!.requestId, value, confirmed)
					}
					onCancel={() =>
						void actions.extensionResponse(state.pendingExtension!.requestId, undefined, undefined)
					}
				/>
			)}
		</div>
	);
}
