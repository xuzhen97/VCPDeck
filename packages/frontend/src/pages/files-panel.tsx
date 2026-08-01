import {
	ChevronLeft,
	ChevronRight,
	File,
	Folder,
	FolderPlus,
	LoaderCircle,
	Maximize2,
	Minimize2,
	RefreshCw,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import { useFileBrowser } from "@/api/hooks/use-file-browser";
import { ConfirmTargetDialog } from "@/components/confirm-target-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
type FileEntry = {
	name: string;
	kind: "file" | "dir";
	size: number;
	mtime: string;
};

export function FilesPanel({ clientId }: { clientId: string }) {
	const sdk = useSdk();
	const browser = useFileBrowser(clientId);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmOverwrite, setConfirmOverwrite] = useState(false);
	const [newDirectoryOpen, setNewDirectoryOpen] = useState(false);
	const [newDirectory, setNewDirectory] = useState("");
	const [destination, setDestination] = useState("");
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		entry: FileEntry;
	} | null>(null);
	const [exportError, setExportError] = useState("");
const [exportNotice, setExportNotice] = useState("");
	const [viewEntry, setViewEntry] = useState<{
		entry: FileEntry;
		rootDir: string;
		path: string;
	} | null>(null);
	const entry = browser.selectedEntry ?? contextMenu?.entry ?? null;
	const relativePath =
		browser.path === "."
			? (entry?.name ?? "")
			: `${browser.path}/${entry?.name ?? ""}`;
	const fullTarget = browser.selectedRoot
		? joinDisplayPath(browser.selectedRoot, relativePath)
		: relativePath;
	const breadcrumbs = browser.path === "." ? [] : browser.path.split("/");

	async function createDirectory() {
		if (!browser.selectedRoot || !newDirectory.trim()) return;
		const path =
			browser.path === "."
				? newDirectory.trim()
				: `${browser.path}/${newDirectory.trim()}`;
		await sdk.files.mkdir(clientId, { rootDir: browser.selectedRoot, path });
		setNewDirectory("");
		setNewDirectoryOpen(false);
		browser.refresh();
	}

	async function deleteSelected() {
		if (!browser.selectedRoot || !entry) return;
		await sdk.files.delete(clientId, {
			rootDir: browser.selectedRoot,
			path: relativePath,
			recursive: entry.kind === "dir",
		});
	}

	async function moveSelected(overwrite = false) {
		if (!browser.selectedRoot || !entry || !destination.trim()) return;
		try {
			await sdk.files.move(clientId, {
				rootDir: browser.selectedRoot,
				source: relativePath,
				destination: destination.trim(),
				overwrite,
			});
			setDestination("");
			browser.refresh();
		} catch (reason) {
			const code =
				typeof reason === "object" && reason !== null && "errorCode" in reason
					? String(reason.errorCode)
					: "";
			if (code === "PATH_CONFLICT") setConfirmOverwrite(true);
			else throw reason;
		}
	}

	const openViewer = useCallback(
		(e: FileEntry) => {
			if (!browser.selectedRoot || e.kind !== "file") return;
			setViewEntry({
				entry: e,
				rootDir: browser.selectedRoot,
				path: browser.path === "." ? e.name : `${browser.path}/${e.name}`,
			});
		},
		[browser.selectedRoot, browser.path],
	);

	// 排序：目录在前，文件在后，各自按名称排序
	const sorted = [...browser.entries].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return (
		<div data-testid="file-browser-panel" className="h-full min-h-0">
			<div
				data-testid="file-browser-layout"
				className="grid h-full min-h-[24rem] gap-4 lg:grid-cols-[13rem_1fr]"
			>
				{/* 左侧：文件根 */}
				<Card className="flex min-h-0 flex-col overflow-hidden">
					<CardHeader>
						<CardTitle>文件根</CardTitle>
					</CardHeader>
					<CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto">
						{browser.loading && browser.roots.length === 0 && (
							<p aria-busy="true" className="text-sm text-muted-foreground">
								正在发现文件根…
							</p>
						)}
						{browser.roots.map((root) => (
							<Button
								key={root}
								className="w-full justify-start font-mono"
								variant={browser.selectedRoot === root ? "secondary" : "ghost"}
								onClick={() => browser.selectRoot(root)}
							>
								<Folder className="size-4" />
								{root}
							</Button>
						))}
					</CardContent>
				</Card>

				{/* 右侧：文件列表 */}
				<Card className="flex min-h-0 flex-col overflow-hidden">
					<CardHeader className="border-b border-border/60 px-5 py-3">
						{browser.selectedRoot ? (
							<nav
								aria-label="当前目录"
								className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm"
							>
								<button
									type="button"
									aria-label={`转到 ${browser.selectedRoot}`}
									className="shrink-0 rounded-md px-2 py-1 font-mono font-semibold hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onClick={() => browser.goTo(".")}
								>
									{browser.selectedRoot}
								</button>
								{breadcrumbs.map((segment, index) => {
									const target = breadcrumbs.slice(0, index + 1).join("/");
									const current = index === breadcrumbs.length - 1;
									return (
										<span
											key={target}
											className="flex shrink-0 items-center gap-1"
										>
											<ChevronRight className="size-3.5 text-muted-foreground" />
											<button
												type="button"
												aria-label={`转到 ${segment}`}
												aria-current={current ? "page" : undefined}
												className={`rounded-md px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${current ? "font-semibold text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
												onClick={() => browser.goTo(target)}
											>
												{segment}
											</button>
										</span>
									);
								})}
							</nav>
						) : (
							<CardTitle className="text-base">选择文件根</CardTitle>
						)}
					</CardHeader>
					<CardContent className="flex min-h-0 flex-1 flex-col pt-3">
						{(() => {
							const err = browser.error;
							const errCode =
								err && typeof err === "object" && "errorCode" in err
									? String(err.errorCode)
									: null;
							const errMsg =
								err &&
								typeof err === "object" &&
								"errorMessage" in err &&
								err.errorMessage
									? String(err.errorMessage)
									: null;
							return err !== undefined ? (
								<div
									role="alert"
									className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
								>
									无法读取目录
									{errCode && (
										<code className="ml-2 rounded bg-red-500/20 px-1">
											{errCode}
										</code>
									)}
									{errMsg && <span className="ml-2 opacity-80">{errMsg}</span>}
								</div>
							) : null;
						})()}
						{exportError && (
							<div
								role="alert"
								className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
							>
								导出下载失败：{exportError}
							</div>
						)}
						{exportNotice && (
							<div
								role="status"
								className="mb-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"
							>
								{exportNotice}
							</div>
						)}
						{browser.selectedRoot && (
							<>
								<div className="mb-3 flex items-center gap-1">
									<Button
										size="sm"
										variant="ghost"
										className="w-9 px-0"
										aria-label="上一级"
										title="上一级"
										onClick={browser.up}
									>
										<ChevronLeft className="size-4" />
									</Button>
									<Button
										size="sm"
										variant="ghost"
										className="w-9 px-0"
										aria-label="刷新目录"
										title="刷新目录"
										onClick={browser.refresh}
									>
										<RefreshCw className="size-4" />
									</Button>
									<Button
										size="sm"
										variant="ghost"
										className="w-9 px-0"
										aria-label="新建文件夹"
										title="新建文件夹"
										onClick={() => setNewDirectoryOpen(true)}
									>
										<FolderPlus className="size-4" />
									</Button>
								</div>
								<div
									data-testid="file-list-region"
									aria-busy={browser.loading}
									className={`relative min-h-32 flex-1 divide-y divide-border/60 overflow-y-auto lg:min-h-0 ${browser.loading ? "pointer-events-none" : ""}`}
								>
									{sorted.map((item) => {
										const selected =
											browser.selectedEntry?.name === item.name &&
											browser.selectedEntry?.kind === item.kind;
										return (
											<div
												key={item.name}
												role="button"
												tabIndex={0}
												className={`flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 rounded-md px-2 py-2 text-left transition-colors select-none ${
													selected
														? "bg-secondary text-foreground"
														: "hover:bg-secondary/60"
												}`}
												onClick={() => browser.select(item)}
												onDoubleClick={() => {
													if (item.kind === "dir") browser.enter(item.name);
													else openViewer(item);
												}}
												onContextMenu={(e) => {
													e.preventDefault();
													browser.select(item);
													setContextMenu({
														x: e.clientX,
														y: e.clientY,
														entry: item,
													});
												}}
												onKeyDown={(e) => {
													if (e.key !== "Enter") return;
													if (item.kind === "dir") browser.enter(item.name);
													else openViewer(item);
												}}
											>
												<span className="flex min-w-0 items-center gap-2">
													{item.kind === "dir" ? (
														<Folder className="size-4 shrink-0 text-primary" />
													) : (
														<File className="size-4 shrink-0 text-muted-foreground" />
													)}
													<span className="truncate">{item.name}</span>
												</span>
												<span className="shrink-0 text-xs text-muted-foreground">
													{item.kind === "dir" ? "目录" : formatSize(item.size)}
												</span>
											</div>
										);
									})}
									{browser.loading && (
										<div
											role="status"
											aria-label="正在读取目录"
											aria-live="polite"
											className="absolute inset-0 flex items-center justify-center gap-2 rounded-lg bg-background/80 text-sm text-muted-foreground backdrop-blur-[2px]"
										>
											<LoaderCircle className="size-5 animate-spin text-primary" />
											<span>正在读取目录…</span>
										</div>
									)}
								</div>
							</>
						)}
					</CardContent>
				</Card>
			</div>

			{/* 右键菜单 */}
			{contextMenu && (
				<div
					className="fixed inset-0 z-40"
					onClick={() => setContextMenu(null)}
					onContextMenu={(e) => {
						e.preventDefault();
						setContextMenu(null);
					}}
				>
					<div
						role="menu"
						aria-label={`${contextMenu.entry.name} 操作`}
						className="absolute z-50 min-w-40 rounded-lg border border-border bg-background p-1.5 text-foreground shadow-2xl ring-1 ring-black/10"
						style={{ left: contextMenu.x, top: contextMenu.y }}
					>
						{contextMenu.entry.kind === "file" && (
							<MenuItem
								label="查看 / 编辑"
								onClick={() => openViewer(contextMenu.entry)}
								close={() => setContextMenu(null)}
							/>
						)}
						<MenuItem
							label="移动"
							onClick={() => {
								setDestination(relativePath);
							}}
							close={() => setContextMenu(null)}
						/>
						<MenuItem
							label="导出下载"
							onClick={async () => {
								const e = contextMenu.entry;
								const rp =
									browser.path === "." ? e.name : `${browser.path}/${e.name}`;
								setExportError("");
								try {
									const exported = await sdk.files.export(clientId, {
										rootDir: browser.selectedRoot!,
										path: rp,
									});
									const token = await sdk.storage.createDownloadToken({
										key: exported.key,
									});
									const anchor = document.createElement("a");
									anchor.href = token.url;
									anchor.download = e.name;
									document.body.append(anchor);
									anchor.click();
									anchor.remove();
									setExportNotice("正在开始下载，请查看浏览器下载栏");
									window.setTimeout(() => setExportNotice(""), 2500);
								} catch (err) {
									setExportError(
										err instanceof Error ? err.message : String(err),
									);
								}
							}}
							close={() => setContextMenu(null)}
						/>
						<div className="my-1 border-t border-border" />
						<MenuItem
							label="删除"
							danger
							onClick={() => setConfirmDelete(true)}
							close={() => setContextMenu(null)}
						/>
					</div>
				</div>
			)}

			<Dialog
				open={newDirectoryOpen}
				onOpenChange={(open) => {
					setNewDirectoryOpen(open);
					if (!open) setNewDirectory("");
				}}
			>
				<DialogContent>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void createDirectory();
						}}
					>
						<DialogTitle>新建文件夹</DialogTitle>
						<DialogDescription>在当前目录中创建一个文件夹。</DialogDescription>
						<div className="mt-5 space-y-2">
							<Label htmlFor="new-directory">文件夹名称</Label>
							<Input
								id="new-directory"
								value={newDirectory}
								onChange={(event) => setNewDirectory(event.target.value)}
								autoFocus
								autoComplete="off"
							/>
						</div>
						<div className="mt-6 flex justify-end gap-2">
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => setNewDirectoryOpen(false)}
							>
								取消
							</Button>
							<Button type="submit" size="sm" disabled={!newDirectory.trim()}>
								创建
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			{/* 移动目标输入 */}
			{browser.selectedRoot && entry && destination && (
				<div className="mt-4 flex gap-2">
					<Input
						aria-label="目标路径"
						value={destination}
						onChange={(event) => setDestination(event.target.value)}
					/>
					<Button onClick={() => void moveSelected(false)}>确认移动</Button>
				</div>
			)}

			{/* 删除确认 */}
			{browser.selectedRoot && entry && (
				<>
					<ConfirmTargetDialog
						open={confirmDelete}
						target={fullTarget}
						title={`删除${entry.kind === "dir" ? "目录" : "文件"}`}
						onOpenChange={setConfirmDelete}
						onConfirm={async () => {
							await deleteSelected();
							setConfirmDelete(false);
							browser.refresh();
						}}
					/>
					<ConfirmTargetDialog
						open={confirmOverwrite}
						target={joinDisplayPath(browser.selectedRoot, destination)}
						title="覆盖目标"
						onOpenChange={setConfirmOverwrite}
						onConfirm={async () => {
							await moveSelected(true);
							setConfirmOverwrite(false);
						}}
					/>
				</>
			)}

			{/* 文件查看 / 编辑弹窗 */}
			{viewEntry && (
				<FileViewerDialog
					clientId={clientId}
					rootDir={viewEntry.rootDir}
					path={viewEntry.path}
					entry={viewEntry.entry}
					onClose={() => setViewEntry(null)}
					onChanged={browser.refresh}
					onDelete={() => setConfirmDelete(true)}
				/>
			)}
		</div>
	);
}

// ── 右键菜单项 ──
function MenuItem({
	label,
	danger,
	onClick,
	close,
}: {
	label: string;
	danger?: boolean;
	onClick: () => void;
	close: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			className={`min-h-10 w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${danger ? "text-red-400 hover:bg-red-500/15" : "hover:bg-secondary"}`}
			onClick={() => {
				onClick();
				close();
			}}
		>
			{label}
		</button>
	);
}

// ── 文件查看 / 编辑弹窗 ──
function FileViewerDialog({
	clientId,
	rootDir,
	path,
	entry,
	onClose,
	onChanged,
	onDelete,
}: {
	clientId: string;
	rootDir: string;
	path: string;
	entry: FileEntry;
	onClose: () => void;
	onChanged: () => void;
	onDelete?: () => void;
}) {
	const sdk = useSdk();
	const [fullscreen, setFullscreen] = useState(false);
	const [content, setContent] = useState("");
	const [message, setMessage] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const controller = new AbortController();
		setMessage("");
		setLoading(true);
		sdk.files
			.readText(clientId, rootDir, path, 262144, controller.signal)
			.then((result) => setContent(result.content))
			.catch((reason: unknown) => {
				if (controller.signal.aborted) return;
				const code =
					typeof reason === "object" && reason !== null && "errorCode" in reason
						? String(reason.errorCode)
						: "";
				setMessage(
					code === "SIZE_EXCEEDED"
						? "文本超过 256 KiB，请使用导出下载"
						: "无法读取文件内容，请重试或使用导出下载",
				);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [clientId, rootDir, path, sdk]);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
			if (e.ctrlKey && e.key === "s") {
				e.preventDefault();
				void handleSave();
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [content]);

	async function handleSave() {
		setSaving(true);
		try {
			await sdk.files.writeText(clientId, {
				rootDir,
				path,
				content,
			});
			onChanged();
		} finally {
			setSaving(false);
		}
	}

	return (
		<div
			className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 ${
				fullscreen ? "p-0" : "p-6"
			}`}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className={`flex flex-col rounded-lg border border-border bg-card shadow-2xl ${
					fullscreen
						? "h-full w-full rounded-none"
						: "max-h-[90vh] w-full max-w-4xl"
				}`}
			>
				{/* 标题栏 */}
				<div className="flex items-center justify-between border-b border-border px-4 py-3">
					<div>
						<h2 className="font-semibold">{entry.name}</h2>
						<p className="text-xs text-muted-foreground">
							{formatSize(entry.size)} · {entry.mtime}
						</p>
					</div>
					<div className="flex items-center gap-1">
						<Button
							size="icon"
							variant="ghost"
							aria-label={fullscreen ? "退出最大化" : "最大化"}
							onClick={() => setFullscreen(!fullscreen)}
						>
							{fullscreen ? (
								<Minimize2 className="size-4" />
							) : (
								<Maximize2 className="size-4" />
							)}
						</Button>
						<Button
							size="icon"
							variant="ghost"
							aria-label="关闭"
							onClick={onClose}
						>
							<X className="size-4" />
						</Button>
					</div>
				</div>

				{/* 内容区 */}
				<div className="flex min-h-80 flex-1 overflow-hidden bg-background/50">
					{loading ? (
						<div
							aria-busy="true"
							className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
						>
							<LoaderCircle className="size-4 animate-spin" />
							正在读取文件…
						</div>
					) : message ? (
						<div className="flex flex-1 items-center justify-center p-12">
							<p role="alert" className="text-sm text-amber-400">
								{message}
							</p>
						</div>
					) : (
						<textarea
							ref={textareaRef}
							aria-label="文件内容"
							className="min-h-80 w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
							value={content}
							onChange={(event) => setContent(event.target.value)}
							spellCheck={false}
						/>
					)}
				</div>

				{/* 底部操作栏 */}
				<div className="flex items-center justify-between border-t border-border px-4 py-3">
					<div className="flex gap-2">
						{!message && (
							<Button size="sm" disabled={saving} onClick={handleSave}>
								{saving ? "保存中…" : "保存 (Ctrl+S)"}
							</Button>
						)}
						<Button
							size="sm"
							variant="outline"
							onClick={async () => {
								const exported = await sdk.files.export(clientId, {
									rootDir,
									path,
								});
								const token = await sdk.storage.createDownloadToken({
									key: exported.key,
								});
								const anchor = document.createElement("a");
								anchor.href = token.url;
								anchor.download = entry.name;
								document.body.append(anchor);
								anchor.click();
								anchor.remove();
							}}
						>
							导出下载
						</Button>
						<Button
							size="sm"
							variant="destructive"
							onClick={() => {
								onClose();
								onDelete?.();
							}}
						>
							删除
						</Button>
					</div>
					<span className="text-xs text-muted-foreground">Esc 关闭</span>
				</div>
			</div>
		</div>
	);
}

// ── 工具函数 ──
function joinDisplayPath(root: string, relative: string): string {
	if (!relative) return root;
	const separator = root.includes("\\") ? "\\" : "/";
	return `${root.replace(/[\\/]$/, "")}${separator}${relative.replaceAll("/", separator)}`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
