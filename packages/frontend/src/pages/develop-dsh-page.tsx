import type { ClientInfo } from "@vcpdeck/shared";
import { ExternalLink, MonitorPlay, Play, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@/api/context";
import { ErrorState, LoadingState } from "@/components/async-state";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	describeLifecycleError,
	dshWebStateBadge,
} from "@/pages/machine-dsh-web-panel";

const POLL_MS = 5_000;

/**
 * 开发落地页：跨机器的远程 DSH（ADR-0059）。
 *
 * 这里只做「选机器 → 起 dsh web → 打开完整 WebUI」这条主路径；真正写代码在
 * DSH 自己的界面里完成，VCPDeck 不复制它的编辑器、终端与会话。
 */
export function DevelopDshPage() {
	const sdk = useSdk();
	const [clients, setClients] = useState<ClientInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [rowError, setRowError] = useState<Record<string, string>>({});

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const next = await sdk.clients.list(signal);
				if (signal?.aborted) return;
				setClients(next);
				setError(null);
			} catch {
				if (!signal?.aborted) setError("无法加载机器列表");
			}
		},
		[sdk],
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		const timer = window.setInterval(() => {
			void load(controller.signal);
		}, POLL_MS);
		return () => {
			controller.abort();
			window.clearInterval(timer);
		};
	}, [load]);

	const lifecycle = useCallback(
		async (client: ClientInfo, action: "start" | "stop") => {
			setBusyId(client.clientId);
			setRowError((current) => {
				const next = { ...current };
				delete next[client.clientId];
				return next;
			});
			try {
				const status =
					action === "start"
						? await sdk.clients.startDshWeb(client.clientId)
						: await sdk.clients.stopDshWeb(client.clientId);
				setClients((current) =>
					current?.map((item) =>
						item.clientId === client.clientId
							? {
									...item,
									dshWebUrl: status.url ?? undefined,
									dshWebState: status.state,
									dshWebPort: status.port ?? undefined,
								}
							: item,
					) ?? null,
				);
			} catch (cause) {
				const code = (cause as { code?: unknown }).code;
				setRowError((current) => ({
					...current,
					[client.clientId]:
						typeof code === "string" ? describeLifecycleError(code) : "操作失败",
				}));
			} finally {
				setBusyId(null);
			}
		},
		[sdk],
	);

	if (clients === null) {
		return error ? (
			<ErrorState message={error} onRetry={() => void load()} />
		) : (
			<LoadingState label="正在加载机器…" />
		);
	}

	return (
		<div className="space-y-4">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">开发</h1>
				<p className="text-sm text-muted-foreground">
					在任意一台机器上一键起一个私有
					<code className="mx-1 rounded bg-secondary px-1 py-0.5 text-xs">
						dsh web
					</code>
					，点「打开」进入完整 DSH——编辑器、终端、插件都在那边。地址含一次性
					token，只在点击时使用。
				</p>
			</header>

			{error && (
				<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{error}
				</div>
			)}

			{clients.length === 0 ? (
				<Card>
					<CardContent className="flex flex-col items-center gap-1 py-10 text-center">
						<p className="text-sm font-medium">还没有机器上线</p>
						<p className="text-sm text-muted-foreground">
							先在目标机启动 Client，注册成功后这里就会出现。
						</p>
					</CardContent>
				</Card>
			) : (
				<div className="grid gap-3 lg:grid-cols-2">
					{clients.map((client) => {
						const badge = dshWebStateBadge(client.dshWebState);
						const busy = busyId === client.clientId;
						const url = client.dshWebUrl;
						return (
							<Card key={client.clientId}>
								<CardHeader className="pb-3">
									<CardTitle className="flex items-center gap-2 text-base">
										<MonitorPlay className="size-4" aria-hidden="true" />
										{client.name ?? client.hostname}
									</CardTitle>
									<p className="truncate font-mono text-xs text-muted-foreground">
										{client.hostname} · {client.clientId}
									</p>
								</CardHeader>
								<CardContent className="space-y-3">
									<div className="flex flex-wrap items-center gap-2">
										<StatusChip label={badge.label} tone={badge.tone} />
										{client.dshWebPort && (
											<span className="font-mono text-xs text-muted-foreground">
												:{client.dshWebPort}
											</span>
										)}
									</div>

									{url ? (
										<p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
											{url.replace(/([?&]token=)[^&]+/, "$1•••")}
										</p>
									) : (
										<p className="text-xs text-muted-foreground">
											还没有 DSH 地址。
										</p>
									)}

									{rowError[client.clientId] && (
										<p className="text-xs text-destructive">
											{rowError[client.clientId]}
										</p>
									)}

									<div className="flex flex-wrap items-center gap-2">
										{client.dshWebState === "running" ? (
											<>
												{url && (
													<Button
														size="sm"
														onClick={() => window.open(url, "_blank", "noreferrer")}
													>
														<ExternalLink className="size-3.5" aria-hidden="true" />
														打开
													</Button>
												)}
												<Button
													size="sm"
													variant="outline"
													disabled={busy}
													onClick={() => void lifecycle(client, "stop")}
												>
													<Square className="size-3.5" aria-hidden="true" />
													{busy ? "停止中…" : "停止并清理"}
												</Button>
											</>
										) : (
											<Button
												size="sm"
												disabled={busy}
												onClick={() => void lifecycle(client, "start")}
											>
												<Play className="size-3.5" aria-hidden="true" />
												{busy ? "启动中…" : "一键启动"}
											</Button>
										)}
										<Button
											size="sm"
											variant="ghost"
											onClick={() =>
												window.open(`/machines/${client.clientId}/develop`, "_self")
											}
										>
											机器详情
										</Button>
									</div>
								</CardContent>
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}
