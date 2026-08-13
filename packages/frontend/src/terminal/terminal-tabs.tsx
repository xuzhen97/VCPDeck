import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";
import type { TerminalSessionInfo, TerminalShellInfo } from "@vcpdeck/shared";
import { TerminalLimits } from "@vcpdeck/shared";
import { StatusChip } from "@/components/status-chip";

const TERMINAL_ENDED = new Set(["exited", "interrupted", "expired", "closed", "error"]);

function tabTone(status: string): "success" | "warning" | "danger" | "neutral" {
	if (TERMINAL_ENDED.has(status)) return "danger";
	if (status === "starting") return "neutral";
	return "success";
}

/** 终端子标签栏：会话列表 + 新建菜单。 */
export function TerminalTabs({
	sessions,
	shells,
	activeId,
	onSelect,
	onNew,
	onCloseTab,
	canCreate,
	createHint,
}: {
	sessions: TerminalSessionInfo[];
	shells: TerminalShellInfo[];
	activeId: string | null;
	onSelect: (sessionId: string) => void;
	onNew: (shellId: string) => void;
	onCloseTab: (sessionId: string) => void;
	canCreate: boolean;
	createHint?: string | null;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	return (
		<div
			data-testid="terminal-tabs"
			className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/70 px-2 py-1.5"
		>
			{sessions.map((session, index) => {
				const label = session.status === "starting" ? "启动中" : session.status;
				return (
					<button
						key={session.sessionId}
						type="button"
						role="tab"
						aria-selected={session.sessionId === activeId}
						aria-label={`${session.shellLabel} ${index + 1}：${label}`}
						onClick={() => onSelect(session.sessionId)}
						className={`group flex min-w-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${
							session.sessionId === activeId
								? "border-primary/40 bg-primary/10 text-primary"
								: "border-border bg-background/50 text-muted-foreground hover:bg-secondary/60"
						}`}
					>
						<span className="truncate">
							{session.shellLabel} {index + 1}
						</span>
						{session.status !== "detached" && session.status !== "active" && (
							<StatusChip label={label} tone={tabTone(session.status)} />
						)}
						{!TERMINAL_ENDED.has(session.status) && (
							<span
								role="button"
								aria-label={`关闭终端 ${session.shellLabel} ${index + 1}`}
								className="rounded p-0.5 hover:bg-destructive/20 hover:text-destructive"
								onClick={(event) => {
									event.stopPropagation();
									onCloseTab(session.sessionId);
								}}
							>
								<X className="size-3" />
							</span>
						)}
					</button>
				);
			})}
			<div className="relative">
				<Button
					size="sm"
					variant="outline"
					disabled={!canCreate}
					title={createHint ?? (canCreate ? "新建终端" : "已达终端会话上限（5 个）")}
					onClick={() => setMenuOpen((open) => !open)}
				>
					<Plus className="size-3.5" />
					新建
				</Button>
				{menuOpen && (
					<div
						data-testid="terminal-new-menu"
						className="absolute left-0 top-full z-40 mt-1 w-52 rounded-lg border border-border bg-background p-1 shadow-xl"
					>
						{shells.length === 0 && (
							<p className="px-2 py-2 text-xs text-muted-foreground">暂无可用 Shell</p>
						)}
						{shells.map((shell) => (
							<button
								key={shell.id}
								type="button"
								className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/70"
								onClick={() => {
									setMenuOpen(false);
									onNew(shell.id);
								}}
							>
								<span>{shell.label}</span>
								{shell.isDefault && <span className="text-[10px] text-muted-foreground">默认</span>}
							</button>
						))}
						{!canCreate && shells.length > 0 && (
							<p className="px-2 py-1.5 text-[11px] text-amber-500">
								每台机器最多 {TerminalLimits.maxSessionsPerClient} 个终端，请先关闭旧终端。
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
