import { useEffect, useRef, useState, type FormEvent } from "react";
import {
	P2P_TUNNEL_PROTOCOL_VERSION,
	type ClientInfo,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { createAppSocket } from "@/terminal/terminal-socket";
import { openBrowserTunnel, type BrowserTunnel, type TunnelPath } from "@/tunnel/browser-tunnel";
import { probeHttp, type HttpProbeResult, type ProbeChannel } from "@/tunnel/http-probe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/status-chip";

interface ProbeState {
	response: HttpProbeResult;
	route: TunnelPath;
}

/**
 * 机器 P2P 隧道 Tab：对目标回环 HTTP 服务发起一次 GET 探测。
 * 一次点击只允许一个活动请求；固定顺序 create → openBrowserTunnel → probeHttp → close → remove；
 * 响应正文只进 <pre>，不注入 DOM HTML；卸载时关闭进行中的 tunnel。
 */
export function TunnelPanel({ client }: { client: ClientInfo }) {
	const sdk = useSdk();
	const [port, setPort] = useState("3000");
	const [path, setPath] = useState("/");
	const [relayOnly, setRelayOnly] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<ProbeState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const tunnelRef = useRef<BrowserTunnel | null>(null);

	const p2p = client.capabilityDetails?.p2pTunnel;
	const supported =
		p2p?.available === true &&
		p2p.protocolVersion === P2P_TUNNEL_PROTOCOL_VERSION;

	useEffect(() => {
		return () => {
			void tunnelRef.current?.close();
			tunnelRef.current = null;
		};
	}, []);

	async function run() {
		if (busy || !supported) return;
		const targetPort = Number.parseInt(port, 10);
		if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
			setError("目标端口非法");
			return;
		}
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			const session = await sdk.tunnels.create({
				clientId: client.clientId,
				targetPort,
			});
			try {
				const tunnel = await openBrowserTunnel({
					socket: createAppSocket(),
					session,
					relayOnly,
				});
				tunnelRef.current = tunnel;
				try {
					// 原生 RTCDataChannel 满足 ProbeChannel 运行时形状；边界处一次性断言
					const response = await probeHttp(
						tunnel.channel as unknown as ProbeChannel,
						path,
					);
					const route = await tunnel.selectedPath();
					setResult({ response, route });
				} finally {
					await tunnel.close();
					tunnelRef.current = null;
				}
			} finally {
				await sdk.tunnels.remove(session.sessionId).catch(() => undefined);
			}
		} catch (err) {
			setError(friendlyTunnelError((err as { code?: string })?.code));
		} finally {
			setBusy(false);
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		void run();
	}

	if (!supported) {
		return (
			<Card>
				<CardContent className="py-10 text-center text-sm text-muted-foreground">
					该 Client 不支持 P2P 隧道协议 v1
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>P2P HTTP 隧道</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<form
					onSubmit={submit}
					className="flex flex-wrap items-end gap-3"
				>
					<div className="space-y-1.5">
						<Label htmlFor="tunnel-port">目标端口</Label>
						<Input
							id="tunnel-port"
							data-testid="tunnel-port"
							value={port}
							inputMode="numeric"
							onChange={(e) => setPort(e.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="tunnel-path">路径</Label>
						<Input
							id="tunnel-path"
							data-testid="tunnel-path"
							value={path}
							onChange={(e) => setPath(e.target.value)}
						/>
					</div>
					<label className="flex items-center gap-2 pb-2 text-sm">
						<input
							type="checkbox"
							aria-label="强制 TURN 中继"
							checked={relayOnly}
							onChange={(e) => setRelayOnly(e.target.checked)}
						/>
						强制 TURN 中继
					</label>
					<Button type="submit" disabled={busy}>
						{busy ? "连接中…" : "连接并测试"}
					</Button>
				</form>

				{error && (
					<p data-testid="tunnel-error" className="text-sm text-destructive">
						{error}
					</p>
				)}

				{result && (
					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-2">
							<StatusChip
								label={
									result.route === "direct"
										? "P2P 直连"
										: result.route === "relay"
											? "TURN 中继"
											: "路径未知"
								}
								tone={result.route === "unknown" ? "warning" : "success"}
							/>
							<span className="font-mono text-sm">{result.response.statusLine}</span>
						</div>
						<pre className="max-h-64 overflow-auto rounded-md border border-border bg-secondary/40 p-3 text-xs">
							{result.response.body}
						</pre>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function friendlyTunnelError(code?: string): string {
	switch (code) {
		case "TUNNEL_CLIENT_UNAVAILABLE":
			return "目标机器当前离线";
		case "TUNNEL_CLIENT_UNSUPPORTED":
			return "该 Client 不支持 P2P 隧道协议 v1";
		case "TUNNEL_TARGET_REFUSED":
			return "目标端口拒绝连接（服务可能未监听）";
		case "TUNNEL_BACKPRESSURE_LIMIT":
			return "隧道数据回压超限，已关闭";
		case "TUNNEL_OPEN_TIMEOUT":
			return "连接建立超时（可能无法打洞或中继不可用）";
		case "TUNNEL_SESSION_EXPIRED":
			return "会话已过期，请重试";
		default:
			return "隧道操作失败，请重试";
	}
}
