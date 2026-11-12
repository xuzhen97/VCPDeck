import type { TailnetKeyInfo, TailnetReuse } from "@vcpdeck/shared";
import { VcpDeckApiError } from "@vcpdeck/sdk";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@/api/context";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PAGE_SIZE = 20;

const REUSE_LABELS: Record<TailnetReuse, string> = {
	unknown: "复用性未声明",
	single: "一次性凭据",
	reusable: "可复用凭据",
};

const USE_LABELS: Record<TailnetKeyInfo["use"], string> = {
	available: "可用",
	reserved: "已预留",
	spent: "已消耗",
	uncertain: "状态不确定",
};

function formatTime(value: string): string {
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? "时间未知" : time.toLocaleString();
}

function describeError(cause: unknown): string {
	if (cause instanceof VcpDeckApiError && cause.code?.startsWith("TAILNET_")) {
		return `操作失败（${cause.code}）`;
	}
	return "操作失败，请稍后重试";
}

/** 导入失败按稳定 code 给出可操作提示，不再把所有原因混成一句。 */
function describeImportError(cause: unknown): string {
	if (cause instanceof VcpDeckApiError) {
		if (cause.code === "TAILNET_KEY_UNAVAILABLE") {
			return "导入失败：服务端 Tailnet 根密钥不可用。请检查缺省根密钥文件 data/tailnet/root.key（或显式 VCPDECK_TAILNET_KEY_FILE）是否与库中已有凭据配对。";
		}
		if (cause.code === "INVALID_TAILNET_INPUT") {
			return "导入失败：授权密钥或声明字段格式不合法（密钥不得含换行，过期时间需为 ISO 时间）。";
		}
		if (cause.code === "TAILNET_KEY_BUSY") {
			return "导入失败：凭据正被任务占用，请稍后重试。";
		}
		return `导入失败（${cause.code ?? cause.status}）`;
	}
	return "导入失败：请稍后重试";
}

/**
 * 设置页的 Tailnet 全局凭据面板（ADR-0062）。
 *
 * 凭据属于 Server 全局资产，不绑定某一台机器；此处只展示安全元数据，
 * 密钥正文仅在导入对话框内提交一次，成功、失败或关闭都会清空。
 */
export function TailnetCredentialsPanel() {
	const sdk = useSdk();
	const [keys, setKeys] = useState<TailnetKeyInfo[]>([]);
	const [page, setPage] = useState(1);
	const [totalPages, setTotalPages] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);
	const [notice, setNotice] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [importName, setImportName] = useState("");
	const [importSecret, setImportSecret] = useState("");
	const [importReuse, setImportReuse] = useState<TailnetReuse>("unknown");
	const [importExpiresAt, setImportExpiresAt] = useState("");
	const [importError, setImportError] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<TailnetKeyInfo | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	const reload = useCallback(() => {
		setReloadToken((value) => value + 1);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		let active = true;
		setLoading(true);
		setLoadError(null);
		sdk.tailnet
			.listKeys({ page, pageSize: PAGE_SIZE }, controller.signal)
			.then((result) => {
				if (!active) return;
				setKeys(result.data);
				setTotalPages(result.totalPages);
			})
			.catch(() => {
				if (active) setLoadError("无法读取 Tailnet 凭据列表");
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
			controller.abort();
		};
	}, [sdk, page, reloadToken]);

	function openImport() {
		setImportName("");
		setImportSecret("");
		setImportReuse("unknown");
		setImportExpiresAt("");
		setImportError(null);
		setImportOpen(true);
	}

	function closeImport() {
		setImportSecret("");
		setImportName("");
		setImportExpiresAt("");
		setImportError(null);
		setImportOpen(false);
	}

	async function submitImport() {
		const name = importName.trim();
		if (name.length === 0 || importSecret.length === 0) {
			setImportError("请填写凭据名称与授权密钥");
			return;
		}
		const expires = importExpiresAt.trim();
		setImporting(true);
		setImportError(null);
		try {
			await sdk.tailnet.importKey({
				name,
				authKey: importSecret,
				declaredReuse: importReuse,
				declaredExpiresAt: expires.length === 0 ? null : expires,
			});
			setImportSecret("");
			setImportName("");
			setImportExpiresAt("");
			setImportOpen(false);
			setNotice("已导入密钥，仅保留名称、声明与使用状态等安全元数据。");
			if (page === 1) reload();
			else setPage(1);
		} catch (cause) {
			setImportSecret("");
			setImportError(describeImportError(cause));
		} finally {
			setImporting(false);
		}
	}

	async function confirmDelete() {
		if (deleteTarget === null) return;
		setDeleting(true);
		setDeleteError(null);
		try {
			await sdk.tailnet.deleteKey(deleteTarget.id);
			setDeleteTarget(null);
			setNotice("已删除本地凭据记录；这不会撤销 Tailscale 中的 Auth key，也不会让设备退网。");
			reload();
		} catch (cause) {
			setDeleteError(describeError(cause));
		} finally {
			setDeleting(false);
		}
	}

	return (
		<Card>
			<CardHeader className="pb-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<CardTitle>Tailnet 凭据</CardTitle>
						<p className="mt-1 text-sm text-muted-foreground">
							全局凭据供所有机器选择使用；这里只保存名称、声明与使用状态，密钥加密保存且不再回显。
							声明不代表真实有效性或复用性。
						</p>
					</div>
					<Button type="button" size="sm" onClick={openImport}>
						导入凭据
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-4 text-sm">
				{loadError && <p className="text-destructive">{loadError}</p>}
				{notice && <p className="text-xs text-muted-foreground">{notice}</p>}
				{loading && keys.length === 0 ? (
					<p className="text-muted-foreground">正在读取凭据…</p>
				) : keys.length === 0 ? (
					<p className="text-muted-foreground">尚未导入凭据</p>
				) : (
					<ul className="space-y-3">
						{keys.map((key) => (
							<li
								key={key.id}
								className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2"
							>
								<div className="min-w-0 space-y-1">
									<p className="font-medium">{key.name}</p>
									<p className="text-xs text-muted-foreground">
										{REUSE_LABELS[key.declaredReuse]} · 使用：
										{USE_LABELS[key.use]}
										{key.declaredExpiresAt
											? ` · 声明过期于 ${formatTime(key.declaredExpiresAt)}`
											: ""}
									</p>
									<p className="text-xs text-muted-foreground">
										导入于 {formatTime(key.createdAt)}
									</p>
								</div>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => {
										setDeleteError(null);
										setDeleteTarget(key);
									}}
								>
									<Trash2 className="size-4" />
									删除
								</Button>
							</li>
						))}
					</ul>
				)}
				{totalPages > 1 && (
					<div className="flex items-center justify-end gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={page <= 1 || loading}
							onClick={() => setPage((value) => Math.max(1, value - 1))}
						>
							上一页
						</Button>
						<span className="text-xs text-muted-foreground">
							第 {page} / {totalPages} 页
						</span>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={page >= totalPages || loading}
							onClick={() => setPage((value) => value + 1)}
						>
							下一页
						</Button>
					</div>
				)}
			</CardContent>

			<Dialog
				open={importOpen}
				onOpenChange={(next) => {
					if (!next) closeImport();
				}}
			>
				<DialogContent>
					<DialogTitle>导入 Tailscale 授权密钥</DialogTitle>
					<DialogDescription>
						密钥只在此对话框内提交一次，服务端加密保存，不会回显；关闭或失败都会清空输入。
					</DialogDescription>
					<div className="mt-4 space-y-3">
						<div className="space-y-1">
							<Label htmlFor="tailnet-credential-name">凭据名称</Label>
							<Input
								id="tailnet-credential-name"
								value={importName}
								maxLength={100}
								disabled={importing}
								onChange={(event) => setImportName(event.target.value)}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="tailnet-credential-secret">Tailscale 授权密钥</Label>
							<Input
								id="tailnet-credential-secret"
								type="password"
								autoComplete="off"
								value={importSecret}
								maxLength={4096}
								disabled={importing}
								onChange={(event) => setImportSecret(event.target.value)}
							/>
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="space-y-1">
								<Label htmlFor="tailnet-credential-reuse">声明的复用性</Label>
								<select
									id="tailnet-credential-reuse"
									className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
									value={importReuse}
									disabled={importing}
									onChange={(event) =>
										setImportReuse(event.target.value as TailnetReuse)
									}
								>
									<option value="unknown">未声明（未知）</option>
									<option value="single">一次性</option>
									<option value="reusable">可复用</option>
								</select>
							</div>
							<div className="space-y-1">
								<Label htmlFor="tailnet-credential-expires">
									声明的过期时间
								</Label>
								<Input
									id="tailnet-credential-expires"
									placeholder="ISO 时间，可留空"
									value={importExpiresAt}
									disabled={importing}
									onChange={(event) => setImportExpiresAt(event.target.value)}
								/>
							</div>
						</div>
						{importError && <p className="text-destructive">{importError}</p>}
						<div className="flex items-center justify-end gap-2">
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={importing}
								onClick={closeImport}
							>
								取消
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={importing}
								onClick={() => void submitImport()}
							>
								保存密钥
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>

			<Dialog
				open={deleteTarget !== null}
				onOpenChange={(next) => {
					if (!next) {
						setDeleteTarget(null);
						setDeleteError(null);
					}
				}}
			>
				<DialogContent>
					<DialogTitle>删除 Tailnet 凭据？</DialogTitle>
					<DialogDescription>
						只删除 VCPDeck 中的密文与元数据，不会撤销 Tailscale 侧 Auth key，也不会让已入网设备退网。
					</DialogDescription>
					{deleteTarget && (
						<p className="mt-3 text-sm">{deleteTarget.name}</p>
					)}
					{deleteError && (
						<p className="mt-3 text-sm text-destructive">{deleteError}</p>
					)}
					<div className="mt-4 flex items-center justify-end gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={deleting}
							onClick={() => {
								setDeleteTarget(null);
								setDeleteError(null);
							}}
						>
							取消
						</Button>
						<Button
							type="button"
							size="sm"
							variant="destructive"
							disabled={deleting}
							onClick={() => void confirmDelete()}
						>
							确认删除
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
