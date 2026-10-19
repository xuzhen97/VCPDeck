import { useEffect, useState } from "react";
import type {
	AcpAdapterEvent,
	AcpPermissionOption,
	RemoteDevSessionInfo,
} from "@vcpdeck/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { RemoteDevSocket } from "../remote-dev/remote-dev-socket.js";

interface PermissionView {
	requestId: string;
	title?: string;
	options: AcpPermissionOption[];
}

const MAX_VISIBLE_EVENTS = 500;

function formatEvent(event: AcpAdapterEvent): string {
	switch (event.type) {
		case "agent.message.delta":
			return event.text;
		case "agent.thought.delta":
			return `[thought] ${event.text}`;
		case "tool.started":
			return `[tool] ${event.title}${event.status ? ` · ${event.status}` : ""}`;
		case "tool.updated":
			return `[tool] ${event.title ?? event.toolCallId}${event.status ? ` · ${event.status}` : ""}`;
		case "plan.updated":
			return `[plan] ${event.entries.length} 项`;
		case "usage.updated":
			return `[usage] ${event.used}/${event.size}`;
		case "permission.requested":
			return `[permission] ${event.title ?? event.requestId}`;
		case "permission.resolved":
			return `[permission] ${event.outcome}`;
		case "session.ended":
			return `[session] ${event.reason}`;
	}
}

export function RemoteDevAgentPanel({
	session,
	socket,
	mode,
}: {
	session: RemoteDevSessionInfo;
	socket: RemoteDevSocket;
	mode: "operator" | "viewer";
}) {
	const [events, setEvents] = useState<AcpAdapterEvent[]>([]);
	const [permission, setPermission] = useState<PermissionView | null>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const busy = session.agentStatus === "busy";

	useEffect(() => {
		return socket.onAgentEvent((event) => {
			if (event.type !== "agent.event") return;
			setEvents((current) => {
				const next = [...current, event.event];
				return next.length > MAX_VISIBLE_EVENTS
					? next.slice(next.length - MAX_VISIBLE_EVENTS)
					: next;
			});
			if (event.event.type === "permission.requested") {
				setPermission({
					requestId: event.event.requestId,
					...(event.event.title ? { title: event.event.title } : {}),
					options: event.event.options,
				});
			}
			if (
				event.event.type === "permission.resolved" ||
				event.event.type === "session.ended"
			) {
				setPermission(null);
			}
		});
	}, [socket]);

	async function send() {
		if (mode !== "operator" || text.trim().length === 0) return;
		try {
			await socket.prompt(session.sessionId, text);
			setText("");
			setError(null);
		} catch (cause) {
			const code = (cause as { code?: unknown }).code;
			setError(typeof code === "string" ? code : "prompt 失败");
		}
	}

	async function answer(optionId?: string) {
		if (!permission || mode !== "operator") return;
		try {
			await socket.permission(session.sessionId, permission.requestId, optionId);
			setPermission(null);
		} catch {
			setError("permission 失败");
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Agent</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<p className="text-xs text-muted-foreground">
					status: {session.agentStatus} · {mode}
				</p>
				<div className="max-h-[420px] space-y-2 overflow-auto rounded-md border p-3 text-sm">
					{events.length === 0 && (
						<p className="text-muted-foreground">还没有 agent 事件。</p>
					)}
					{events.map((event, index) => (
						<div key={`${event.type}-${index}`} className="whitespace-pre-wrap">
							{formatEvent(event)}
						</div>
					))}
				</div>
				{permission && (
					<div className="rounded-md border border-amber-400 p-3">
						<p className="mb-2 text-sm font-medium">
							Permission: {permission.title ?? permission.requestId}
						</p>
						<div className="flex flex-wrap gap-2">
							{permission.options.map((option) => (
								<Button
									key={option.optionId}
									disabled={mode !== "operator"}
									onClick={() => void answer(option.optionId)}
								>
									{option.name}
								</Button>
							))}
							<Button
								variant="outline"
								disabled={mode !== "operator"}
								onClick={() => void answer()}
							>
								Reject
							</Button>
						</div>
					</div>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
				<div className="flex gap-2">
					<Input
						value={text}
						disabled={mode !== "operator"}
						placeholder={busy ? "agent 正在处理…" : "给 agent 发消息…"}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void send();
						}}
					/>
					<Button
						disabled={mode !== "operator" || busy}
						onClick={() => void send()}
					>
						发送
					</Button>
					<Button
						variant="outline"
						disabled={mode !== "operator"}
						onClick={() =>
							void socket.cancel(session.sessionId).catch(() => setError("取消失败"))
						}
					>
						取消
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
