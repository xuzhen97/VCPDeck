import { useState } from "react";
import type { RemoteDevPortInfo, RemoteDevSessionInfo } from "@vcpdeck/shared";import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";
import type { RemoteDevSocket } from "../remote-dev/remote-dev-socket.js";

export function RemoteDevPortsPanel({
	session,
	ports,
	socket,
	mode,
}: {
	session: RemoteDevSessionInfo;
	ports: RemoteDevPortInfo[];
	socket: RemoteDevSocket;
	mode: "operator" | "viewer";
}) {
	const [remotePort, setRemotePort] = useState("3000");
	const [error, setError] = useState<string | null>(null);

	async function open() {
		const port = Number(remotePort);
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			setError("端口必须是 1024-65535 的整数");
			return;
		}
		try {
			await socket.openPort(session.sessionId, port);
			setError(null);
		} catch (cause) {
			const code = (cause as { code?: unknown }).code;
			setError(typeof code === "string" ? code : "打开端口失败");
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>端口</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex gap-2">
					<Input
						value={remotePort}
						onChange={(event) => setRemotePort(event.target.value)}
						placeholder="目标机 loopback 端口"
						disabled={mode !== "operator"}
					/>
					<Button
						disabled={mode !== "operator"}
						onClick={() => void open()}
					>
						打开
					</Button>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				{ports.length === 0 && (
					<p className="text-sm text-muted-foreground">还没有打开的端口。</p>
				)}
				{ports.map((port) => (
					<div
						key={port.portId}
						className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
					>
						<span>
							127.0.0.1:{port.remotePort} · {port.status}
							{port.label ? ` · ${port.label}` : ""}
						</span>
						<div className="flex gap-2">
							<Button
								variant="outline"
								onClick={() =>
									void copyText(
										`vcpdeck forward --session ${session.sessionId} --remote-port ${port.remotePort}`,
									)
								}
							>
								复制 forward 命令
							</Button>
							<Button
								variant="outline"
								disabled={mode !== "operator"}
								onClick={() =>
									void socket
										.closePort(session.sessionId, port.portId)
										.catch(() => setError("关闭端口失败"))
								}
							>
								关闭
							</Button>
						</div>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
