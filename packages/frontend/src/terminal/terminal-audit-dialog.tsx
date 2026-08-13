import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSdk } from "@/api/context";
import type { TerminalAuditInfo } from "@vcpdeck/shared";

const EVENT_LABELS: Record<string, string> = {
	created: "创建",
	create_failed: "创建失败",
	attached: "连接",
	detached: "断开",
	takeover: "接管",
	closed: "关闭",
	expired: "过期",
	exited: "Shell 退出",
	interrupted: "已中断",
};

/** 终端最小审计对话框（分页；不展示输入输出）。 */
export function TerminalAuditDialog({
	clientId,
	sessionId,
	open,
	onOpenChange,
}: {
	clientId: string;
	sessionId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const sdk = useSdk();
	const [items, setItems] = useState<TerminalAuditInfo[]>([]);
	const [total, setTotal] = useState(0);
	const [page, setPage] = useState(1);
	const pageSize = 20;

	useEffect(() => {
		if (!open || !sessionId) return;
		let cancelled = false;
		void sdk.terminals
			.audit(clientId, sessionId, { page, pageSize })
			.then((result) => {
				if (cancelled) return;
				setItems(result.data);
				setTotal(result.total);
			})
			.catch(() => {
				if (!cancelled) {
					setItems([]);
					setTotal(0);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [sdk, clientId, sessionId, open, page]);

	const totalPages = Math.max(1, Math.ceil(total / pageSize));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogTitle>终端操作记录</DialogTitle>
				<DialogDescription>仅记录会话生命周期事件，不保存任何终端输入输出。</DialogDescription>
				<div data-testid="terminal-audit-list" className="max-h-80 space-y-1 overflow-y-auto py-2">
					{items.length === 0 && (
						<p className="py-6 text-center text-sm text-muted-foreground">暂无记录</p>
					)}
					{items.map((item) => (
						<div
							key={item.id}
							className="flex items-center justify-between rounded-md border border-border/60 px-2.5 py-1.5 text-xs"
						>
							<div className="min-w-0">
								<span className="font-medium">{EVENT_LABELS[item.event] ?? item.event}</span>
								{item.actorName && <span className="ml-2 text-muted-foreground">by {item.actorName}</span>}
								{item.result === "error" && item.reason && (
									<span className="ml-2 text-amber-500">{item.reason}</span>
								)}
							</div>
							<span className="shrink-0 text-muted-foreground">
								{new Date(item.createdAt).toLocaleString()}
							</span>
						</div>
					))}
				</div>
				<div className="flex items-center justify-between pt-2">
					<span className="text-xs text-muted-foreground">
						共 {total} 条 · 第 {page}/{totalPages} 页
					</span>
					<div className="flex gap-2">
						<Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
							上一页
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={page >= totalPages}
							onClick={() => setPage((p) => p + 1)}
						>
							下一页
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
