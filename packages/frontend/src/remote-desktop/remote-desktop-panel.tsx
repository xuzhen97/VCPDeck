import type { ClientInfo, RemoteDesktopClipboardMode, RemoteDesktopQualityProfile, RemoteDesktopSessionInfo } from "@vcpdeck/shared";
import { MonitorUp, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { RemoteDesktopView } from "./remote-desktop-view";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusChip } from "@/components/status-chip";

const SESSION_STATUS_LABELS = {
	creating: "创建中",
	ready: "待连接",
	connecting: "连接中",
	connected: "已连接",
	detached: "已分离",
	closed: "已关闭",
	interrupted: "已中断",
	error: "错误",
} satisfies Record<string, string>;

function sessionStatusLabel(status: string): string {
	return SESSION_STATUS_LABELS[status as keyof typeof SESSION_STATUS_LABELS] ?? status;
}

function isRemoteDesktopAvailable(client: ClientInfo): boolean {
	return (
		client.capabilities.includes("remote-desktop") &&
		client.capabilityDetails?.remoteDesktop?.available === true
	);
}

/**
 * 是否允许展示 Ctrl+Alt+Del 动作。
 *
 * 必须同时满足「远程桌面可用」与「Host 真实探测声明了 secureAttention」：
 * 缺失该字段时一律为 false，绝不因为平台是 Windows 就假定支持。
 */
export function supportsSecureAttention(client: ClientInfo): boolean {
	return (
		isRemoteDesktopAvailable(client) &&
		client.capabilityDetails?.remoteDesktop?.secureAttention === true
	);
}

/** 远程桌面控制面板；只在 Client 明确报告能力可用时开放创建入口。 */
export function RemoteDesktopPanel({ client }: { client: ClientInfo }) {
	const sdk = useSdk();
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
	const available = isRemoteDesktopAvailable(client);
	const secureAttentionSupported = supportsSecureAttention(client);
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [qualityProfile, setQualityProfile] = useState<RemoteDesktopQualityProfile>("balanced");
	const [clipboardMode, setClipboardMode] = useState<RemoteDesktopClipboardMode>("off");
	const load = useCallback(
		(signal: AbortSignal) => available
			? sdk.remoteDesktop.list(client.clientId, { page: 1, pageSize: 20 }, signal)
			: Promise.resolve({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }),
		[available, sdk, client.clientId],
	);
	const resource = useResource(load);
	useEffect(() => {
		if (!available && activeSessionId) setActiveSessionId(null);
	}, [activeSessionId, available]);

	const createSession = async () => {
		setCreating(true);
		setCreateError(null);
		try {
			await sdk.remoteDesktop.create(client.clientId, {
				qualityProfile,
				clipboardMode,
			});
			resource.reload();
		} catch {
			setCreateError("远程桌面会话创建失败");
		} finally {
			setCreating(false);
		}
	};

	if (!available) {
		return (
			<Card data-testid="remote-desktop-unavailable">
				<CardContent className="py-12 text-center">
					<MonitorUp className="mx-auto size-8 text-muted-foreground" />
					<h2 className="mt-3 font-semibold">远程桌面不可用</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						目标 Client 尚未报告可用的 Desktop Host 能力。
					</p>
				</CardContent>
			</Card>
		);
	}

	if (resource.loading) return <LoadingState label="正在加载远程桌面会话…" />;
	if (resource.error) {
		return (
			<ErrorState
				message="无法加载远程桌面会话"
				onRetry={resource.reload}
			/>
		);
	}

	const sessions = resource.data?.data ?? [];
	if (activeSessionId) {
		return (
			<RemoteDesktopView
				client={client}
				sessionId={activeSessionId}
				clipboardMode={sessions.find((session) => session.id === activeSessionId)?.clipboardMode ?? "off"}
				displays={sessions.find((session) => session.id === activeSessionId)?.displays ?? []}
				selectedDisplayId={sessions.find((session) => session.id === activeSessionId)?.selectedDisplayId ?? null}
				secureAttentionSupported={secureAttentionSupported}
				onClose={() => setActiveSessionId(null)}
			/>
		);
	}
	return (
		<div className="space-y-4" data-testid="remote-desktop-panel">
			<Card>
				<CardHeader className="flex flex-row items-center justify-between gap-4">
					<div>
						<CardTitle>远程桌面</CardTitle>
						<p className="mt-1 text-sm text-muted-foreground">
							{client.capabilityDetails?.remoteDesktop?.backend ?? "unknown"} · Host{" "}
							{client.capabilityDetails?.remoteDesktop?.hostVersion ?? "未知版本"}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<select aria-label="画质" value={qualityProfile} onChange={(event) => setQualityProfile(event.target.value as RemoteDesktopQualityProfile)} className="h-9 rounded-lg border border-border bg-background px-2 text-xs">
							<option value="low-bandwidth">低带宽</option>
							<option value="balanced">平衡</option>
							<option value="high-quality">高画质</option>
						</select>
						<select aria-label="剪贴板模式" value={clipboardMode} onChange={(event) => setClipboardMode(event.target.value as RemoteDesktopClipboardMode)} className="h-9 rounded-lg border border-border bg-background px-2 text-xs">
							<option value="off">剪贴板关闭</option>
							<option value="browser-to-remote">仅发送到远端</option>
							<option value="bidirectional">双向剪贴板</option>
						</select>
						<Button
							size="sm"
							disabled={creating}
							onClick={() => void createSession()}
						>
							<Plus className="size-4" />
							创建远程桌面会话
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					{createError && (
						<p role="alert" className="mb-3 text-sm text-destructive">
							{createError}
						</p>
					)}
					{sessions.length === 0 ? (
						<p className="py-8 text-center text-sm text-muted-foreground">
							尚未创建远程桌面会话。
						</p>
					) : (
						<div className="space-y-2">
							{sessions.map((session) => (
								<SessionRow
									key={session.id}
									session={session}
									onOpen={() => setActiveSessionId(session.id)}
								/>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function SessionRow({
	session,
	onOpen,
}: {
	session: RemoteDesktopSessionInfo;
	onOpen: () => void;
}) {
	const canOpen = ["ready", "connecting", "connected", "detached"].includes(session.status);
	return (
		<div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 p-3">
			<div className="min-w-0">
				<p className="truncate text-sm font-medium">{session.id}</p>
				<p className="mt-1 text-xs text-muted-foreground">
					{session.qualityProfile} · 剪贴板 {session.clipboardMode}
				</p>
			</div>
			<div className="flex items-center gap-2">
				<StatusChip label={sessionStatusLabel(session.status)} />
				{canOpen && (
					<Button size="sm" variant="outline" onClick={onOpen}>
						连接
					</Button>
				)}
			</div>
		</div>
	);
}
