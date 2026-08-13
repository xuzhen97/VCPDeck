import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/status-chip";
import { History, ShieldCheck, Square } from "lucide-react";
import type { TerminalSessionState } from "./use-terminal-session.js";

/** 会话状态标签（文字 + 可访问名称，不只靠颜色）。 */
function statusLabel(state: TerminalSessionState): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
	switch (state.phase) {
		case "attaching":
			return { label: "连接中…", tone: "neutral" };
		case "syncing":
			return { label: "正在恢复画面…", tone: "neutral" };
		case "live":
			return state.mode === "operator" ? { label: "操作中", tone: "success" } : { label: "只读", tone: "neutral" };
		case "ended":
			return { label: `会话已${state.status === "interrupted" ? "中断" : state.status === "exited" ? "退出" : "结束"}`, tone: "danger" };
		case "error":
			return { label: "连接失败", tone: "danger" };
		case "idle":
		case "reconnecting":
			return { label: "恢复中…", tone: "warning" };
	}
}

/** 终端控制条：状态、保护倒计时、接管、关闭与审计入口。 */
export function TerminalControl({
	state,
	shellLabel,
	onTakeover,
	onClose,
	onAudit,
}: {
	state: TerminalSessionState;
	shellLabel: string;
	onTakeover: () => void;
	onClose: () => void;
	onAudit: () => void;
}) {
	const status = statusLabel(state);
	const protectedUntil = state.controlProtectedUntil ? new Date(state.controlProtectedUntil) : null;
	const protectedSeconds =
		protectedUntil && protectedUntil.getTime() > Date.now()
			? Math.max(0, Math.ceil((protectedUntil.getTime() - Date.now()) / 1000))
			: 0;
	return (
		<div
			data-testid="terminal-control"
			className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2"
		>
			<span className="text-sm font-medium">{shellLabel}</span>
			<StatusChip label={status.label} tone={status.tone} />
			{state.phase === "live" && state.mode === "viewer" && (
				<>
					<span className="text-xs text-muted-foreground">
						{protectedSeconds > 0
							? `操作者重连保护中（${protectedSeconds}s）`
							: state.operatorName
								? `当前操作者：${state.operatorName}`
								: "等待操作者"}
					</span>
					{state.canTakeover && (
						<Button size="sm" variant="outline" onClick={onTakeover}>
							接管
						</Button>
					)}
				</>
			)}
			<div className="ml-auto flex items-center gap-2">
				<Button size="sm" variant="ghost" onClick={onAudit} aria-label="操作记录">
					<History className="size-4" />
					<span className="hidden sm:inline">记录</span>
				</Button>
				<Button size="sm" variant="destructive" onClick={onClose}>
					<Square className="size-3.5" />
					关闭终端
				</Button>
			</div>
			{state.phase === "live" && (
				<span className="flex w-full items-center gap-1.5 text-[11px] text-amber-500/90">
					<ShieldCheck className="size-3.5" />
					终端继承远程 Client OS 用户权限，不是沙箱；请勿输入敏感凭据。
				</span>
			)}
		</div>
	);
}
