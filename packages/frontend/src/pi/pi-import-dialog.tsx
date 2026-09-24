import { useCallback, useEffect, useState } from "react";
import type {
	PiImportRunResult,
	PiImportSessionSummary,
} from "@vcpdeck/shared";
import type { PiApi } from "@vcpdeck/sdk";
import { apiErrorMessage } from "@/api/error-message";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** 拒绝原因 → 中文（稳定码之外不依赖上游文案）。 */
const REJECT_COPY: Record<string, string> = {
	PI_PROJECT_NOT_ALLOWED: "cwd 不在允许根",
	PI_SESSION_NOT_FOUND: "源不存在或无法读取",
	PI_CONFIG_UNAVAILABLE: "复制或校验失败",
};

/** 列表里禁用勾选的原因（仅后两类，ADR-0031/设计 §10）。 */
function disabledReason(item: PiImportSessionSummary): string | null {
	if (item.unreadable) return "无法读取";
	if (item.cwdNotAllowed) return "cwd 不在允许根";
	return null;
}

function resultLabel(item: PiImportRunResult): string {
	if (item.status !== "rejected") {
		return item.status === "imported" ? "已导入到副本" : "此前已导入";
	}
	const code = item.reasonCode ?? "";
	return `拒绝：${REJECT_COPY[code] ?? (code || "未知原因")}`;
}

export interface PiImportDialogProps {
	pi: Pick<PiApi, "sessions">;
	clientId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * 旧会话显式导入（ADR-0031；设计 §21.3）：只读列摘要 → 逐条显式预览 →
 * 勾选 → 二次确认 → 单向导入。预览与导入都是显式动作，正文不落盘。
 */
export function PiImportDialog({
	pi,
	clientId,
	open,
	onOpenChange,
}: PiImportDialogProps) {
	const [sessions, setSessions] = useState<PiImportSessionSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [previewAsk, setPreviewAsk] = useState<string | null>(null);
	const [previews, setPreviews] = useState<
		Record<string, { previewText: string; truncated: boolean }>
	>({});
	const [confirming, setConfirming] = useState(false);
	const [results, setResults] = useState<PiImportRunResult[] | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		setError(null);
		try {
			const list = await pi.sessions.importable(clientId);
			setSessions(list.sessions);
		} catch (err) {
			setError(apiErrorMessage(err, "无法列出可导入的会话"));
			setSessions([]);
		}
	}, [pi, clientId]);

	useEffect(() => {
		if (!open) return;
		setSessions(null);
		setSelected([]);
		setPreviews({});
		setPreviewAsk(null);
		setConfirming(false);
		setResults(null);
		void load();
	}, [open, load]);

	const toggle = (sourceName: string) => {
		setSelected((prev) =>
			prev.includes(sourceName)
				? prev.filter((name) => name !== sourceName)
				: [...prev, sourceName],
		);
	};

	const confirmPreview = async () => {
		if (!previewAsk) return;
		const sourceName = previewAsk;
		setBusy(true);
		setError(null);
		try {
			const preview = await pi.sessions.previewImportable(clientId, sourceName);
			setPreviews((prev) => ({
				...prev,
				[sourceName]: {
					previewText: preview.previewText,
					truncated: preview.truncated,
				},
			}));
			setPreviewAsk(null);
		} catch (err) {
			setError(apiErrorMessage(err, "预览失败"));
		} finally {
			setBusy(false);
		}
	};

	const doImport = async () => {
		setConfirming(false);
		setBusy(true);
		setError(null);
		try {
			const response = await pi.sessions.import(clientId, selected);
			setResults(response.results);
			setSelected([]);
			await load(); // 刷新 imported 标记
		} catch (err) {
			setError(apiErrorMessage(err, "导入失败"));
		} finally {
			setBusy(false);
		}
	};

	const firstSelectedCwd =
		sessions?.find((item) => item.sourceName === selected[0])?.cwd ??
		"未知项目";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[80vh] overflow-y-auto">
				<DialogTitle>导入旧会话</DialogTitle>
				<DialogDescription>
					从本机用户原生 Pi 中选择会话，单向复制到 VCPDeck；源文件保持只读（0 created /
					0 modified / 0 deleted）。
				</DialogDescription>

				{error && (
					<div
						data-testid="pi-import-error"
						className="text-sm text-destructive"
					>
						{error}
					</div>
				)}

				{sessions === null && (
					<div className="text-sm text-muted-foreground">加载中…</div>
				)}
				{sessions?.length === 0 && (
					<div className="text-sm text-muted-foreground">没有可导入的会话</div>
				)}

				{sessions && sessions.length > 0 && (
					<ul className="space-y-2">
						{sessions.map((item) => {
							const reason = disabledReason(item);
							const preview = previews[item.sourceName];
							return (
								<li
									key={item.sourceLabel}
									className="rounded-md border border-border/70 p-2 text-sm"
								>
									<label
										className={cn(
											"flex items-center gap-2",
											reason && "opacity-60",
										)}
									>
										<input
											type="checkbox"
											disabled={reason !== null}
											checked={selected.includes(item.sourceName)}
											onChange={() => toggle(item.sourceName)}
											aria-label={item.sourceLabel}
										/>
										<span className="font-mono">{item.sourceLabel}</span>
										{item.imported && (
											<span className="rounded bg-secondary/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
												已导入
											</span>
										)}
									</label>

									<div className="text-xs text-muted-foreground">
										{item.startedAt
											? new Date(item.startedAt).toLocaleString()
											: "时间未知"}{" "}
										· {item.entryCount} 条
										{item.cwd ? ` · ${item.cwd}` : ""}
									</div>

									{reason && <div className="text-xs text-destructive">{reason}</div>}

									<div className="mt-1 flex items-center gap-2">
										<Button
											type="button"
											size="sm"
											variant="ghost"
											disabled={busy || item.unreadable}
											onClick={() => setPreviewAsk(item.sourceName)}
										>
											预览
										</Button>
										{preview && (
											<span className="text-xs text-muted-foreground">
												{preview.previewText}
												{preview.truncated ? "…" : ""}
											</span>
										)}
									</div>

									{previewAsk === item.sourceName && (
										<div className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
											<div>预览会读取该会话正文</div>
											<div className="mt-1 flex gap-2">
												<Button
													type="button"
													size="sm"
													disabled={busy}
													onClick={() => void confirmPreview()}
												>
													{busy ? "读取中…" : "确认预览"}
												</Button>
												<Button
													type="button"
													size="sm"
													variant="ghost"
													onClick={() => setPreviewAsk(null)}
												>
													取消
												</Button>
											</div>
										</div>
									)}
								</li>
							);
						})}
					</ul>
				)}

				{results && (
					<ul data-testid="pi-import-results" className="space-y-1 text-sm">
						{results.map((item) => (
							<li key={item.sourceName} className="flex gap-1">
								<span className="font-mono">{item.sourceName}：</span>
								<span>{resultLabel(item)}</span>
							</li>
						))}
					</ul>
				)}

				{confirming && (
					<div
						data-testid="pi-import-confirm"
						className="space-y-2 rounded-md border border-border/70 p-3 text-sm"
					>
						<div>
							将导入 {selected.length} 个会话到项目 {firstSelectedCwd}
						</div>
						<ul className="space-y-0.5 font-mono text-xs">
							{selected.map((name) => (
								<li key={name}>{name}</li>
							))}
						</ul>
						<div className="flex gap-2">
							<Button type="button" size="sm" disabled={busy} onClick={() => void doImport()}>
								确认导入
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => setConfirming(false)}
							>
								返回
							</Button>
						</div>
					</div>
				)}

				<div className="flex items-center justify-between">
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						关闭
					</Button>
					<Button
						type="button"
						disabled={busy || selected.length === 0}
						onClick={() => setConfirming(true)}
					>
						导入（{selected.length}）
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
