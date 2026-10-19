import type { ClientInfo } from "@vcpdeck/shared";
import { ExternalLink, MonitorPlay, Play, Save, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useSdk } from "@/api/context";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";

/** 把生命周期错误码翻成可操作的中文；未知码原样返回。 */
export function describeLifecycleError(code: string): string {
	if (code === "DSH_WEB_FRP_UNAVAILABLE") {
		return "没有可用的 FRP 实例：先在 FRP 页配置一个 frps，再点一键启动";
	}
	if (code === "DSH_WEB_CLIENT_OFFLINE") return "目标机器不在线";
	if (code === "DSH_WEB_UNSUPPORTED") {
		return "目标机器的 Client 版本较旧，不支持代起 dsh web";
	}
	if (code === "DSH_WEB_COMMAND_FAILED") {
		return "目标机启动 dsh web 失败（检查本机是否装了 dsh）";
	}
	if (code === "DSH_WEB_STOP_INCOMPLETE") {
		return "进程没能退出，端口仍被占用；再点一次停止即可重试清理";
	}
	return code;
}

/** 状态 → 徽章文案与色调；跨机器列表与机器内卡片共用。 */
export function dshWebStateBadge(state?: string): {
	label: string;
	tone: "neutral" | "success" | "warning" | "danger";
} {
	if (state === "running") return { label: "运行中", tone: "success" };
	if (state === "starting") return { label: "启动中", tone: "warning" };
	if (state === "failed") return { label: "失败", tone: "danger" };
	return { label: "已停止", tone: "neutral" };
}

/**
 * 远程 DSH WebUI 入口（ADR-0059）。
 *
 * 一键启动会代起目标机的 dsh web 并自动建 FRP 映射；也可以手工登记地址。
 * 地址可能含一次性 token：只在点击时打开，界面默认打码展示。
 */
export function MachineDshWebPanel({ client }: { client: ClientInfo }) {
	const sdk = useSdk();
	const [saved, setSaved] = useState<string | null>(client.dshWebUrl ?? null);
	const [draft, setDraft] = useState(client.dshWebUrl ?? "");
	const [saving, setSaving] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	// 生命周期返回的状态优先：父级轮询要好几秒才拿到新值，不能让人以为按钮没反应。
	const [local, setLocal] = useState<{
		state: string;
		url: string | null;
	} | null>(null);

	// Server 是权威；父级轮询刷新后同步回填并丢掉本地乐观值。
	useEffect(() => {
		setSaved(client.dshWebUrl ?? null);
		setDraft(client.dshWebUrl ?? "");
		setLocal(null);
	}, [client.dshWebUrl, client.dshWebState]);

	async function lifecycle(action: "start" | "stop") {
		setBusy(true);
		setError(null);
		try {
			const status =
				action === "start"
					? await sdk.clients.startDshWeb(client.clientId)
					: await sdk.clients.stopDshWeb(client.clientId);
			setSaved(status.url ?? null);
			setDraft(status.url ?? "");
			setLocal({ state: status.state, url: status.url ?? null });
		} catch (cause) {
			const code = (cause as { code?: unknown }).code;
			setError(typeof code === "string" ? describeLifecycleError(code) : "操作失败");
		} finally {
			setBusy(false);
		}
	}

	async function save() {
		setSaving(true);
		setError(null);
		try {
			const updated = await sdk.clients.setDshWebUrl(
				client.clientId,
				draft.trim().length === 0 ? null : draft.trim(),
			);
			setSaved(updated.dshWebUrl ?? null);
			setDraft(updated.dshWebUrl ?? "");
		} catch (cause) {
			const code = (cause as { code?: unknown }).code;
			setError(typeof code === "string" ? code : "保存失败");
		} finally {
			setSaving(false);
		}
	}

	const dirty = draft.trim() !== (saved ?? "");
	const state = local?.state ?? client.dshWebState ?? "stopped";
	const badge = dshWebStateBadge(state);

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-base">
					<MonitorPlay className="size-4" aria-hidden="true" />
					远程 DSH
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<StatusChip label={badge.label} tone={badge.tone} />
					{state !== "running" ? (
						<Button
							size="sm"
							disabled={busy || state === "starting"}
							onClick={() => void lifecycle("start")}
						>
							<Play className="size-3.5" aria-hidden="true" />
							{busy ? "启动中…" : "一键启动"}
						</Button>
					) : (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => void lifecycle("stop")}
						>
							<Square className="size-3.5" aria-hidden="true" />
							{busy ? "停止中…" : "停止并清理"}
						</Button>
					)}
					<p className="text-xs text-muted-foreground">
						一键启动会在目标机代起 dsh web 并自动建 FRP 映射；停止会停进程、删映射、清地址。
					</p>
				</div>

				{saved ? (
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
							{saved.replace(/([?&]token=)[^&]+/, "$1•••")}
						</span>
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								void copyText(saved).then(() => {
									setCopied(true);
									window.setTimeout(() => setCopied(false), 1500);
								});
							}}
						>
							{copied ? "已复制" : "复制"}
						</Button>
						<Button asChild size="sm">
							<a href={saved} target="_blank" rel="noreferrer">
								<ExternalLink className="size-3.5" aria-hidden="true" />
								打开
							</a>
						</Button>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						还没有可用的 DSH 地址。点「一键启动」自动准备；也可以手工在目标机运行{" "}
						<code className="rounded bg-secondary/60 px-1">
							dsh --profile web --host 127.0.0.1 --port &lt;端口&gt; --public-url
							&lt;对外 URL&gt; --trusted-host &lt;对外 authority&gt;
						</code>
						，经 FRP 或内网暴露后把地址填到下面。
					</p>
				)}

				<div className="flex items-center gap-2">
					<Input
						className="min-w-0 flex-1 font-mono text-xs"
						placeholder="https://dsh.example.com/?token=…"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<Button
						size="sm"
						className="shrink-0 whitespace-nowrap"
						disabled={saving || !dirty}
						onClick={() => void save()}
					>
						<Save className="size-3.5" aria-hidden="true" />
						{saving ? "保存中…" : "保存"}
					</Button>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<p className="text-xs text-muted-foreground">
					地址可能含一次性 token：只经此页下发，不写日志。仅检测"是否可达"由你在浏览器打开时判断。
				</p>
			</CardContent>
		</Card>
	);
}
