import {
	Folder,
	FolderPlus,
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
import { Input } from "@/components/ui/input";
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
	const [newDirectory, setNewDirectory] = useState("");
	const [destination, setDestination] = useState("");
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		entry: FileEntry;
	} | null>(null);
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

	async function createDirectory() {
		if (!browser.selectedRoot || !newDirectory.trim()) return;
		const path =
			browser.path === "."
				? newDirectory.trim()
				: `${browser.path}/${newDirectory.trim()}`;
		await sdk.files.mkdir(clientId, { rootDir: browser.selectedRoot, path });
		setNewDirectory("");
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
		<div className="space-y-4">
			<p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
				文件能力仅面向可信操作者；当前 Client 的 symlink 边界仍有已知风险。
			</p>
			<div className="grid min-h-[34rem] gap-4 lg:grid-cols-[13rem_1fr]">
				{/* 左侧：文件根 */}
				<Card>
					<CardHeader>
						<CardTitle>文件根</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2">
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
				<Card>
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle>
								{browser.selectedRoot
									? joinDisplayPath(
											browser.selectedRoot,
											browser.path === "." ? "" : browser.path,
										)
									: "选择文件根"}
							</CardTitle>
							{browser.selectedRoot && (
								<Button
									size="icon"
									variant="ghost"
									aria-label="刷新目录"
									onClick={browser.refresh}
								>
									<RefreshCw />
								</Button>
							)}
						</div>
					</CardHeader>
					<CardContent>
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
						{browser.selectedRoot && (
							<>
								<div className="mb-4 flex gap-2">
									<Button variant="outline" onClick={browser.up}>
										上一级
									</Button>
									<Input
										aria-label="新目录名称"
										placeholder="新建目录…"
										value={newDirectory}
										onChange={(event) => setNewDirectory(event.target.value)}
									/>
									<Button
										variant="outline"
										disabled={!newDirectory.trim()}
										onClick={createDirectory}
									>
										<FolderPlus />
										新建
									</Button>
								</div>
								<div className="divide-y divide-border/60">
									{sorted.map((item) => {
										const selected =
											browser.selectedEntry?.name === item.name &&
											browser.selectedEntry?.kind === item.kind;
										return (
											<div
												key={item.name}
												role="button"
												tabIndex={0}
												className={`flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 px-2 py-2 text-left select-none ${
													selected ? "bg-accent" : "hover:bg-accent/50"
												}`}
												onClick={() => {
													browser.select(item);
													if (item.kind === "file") openViewer(item);
												}}
												onDoubleClick={() => {
													if (item.kind === "dir") browser.enter(item.name);
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
													if (e.key === "Enter" && item.kind === "dir")
														browser.enter(item.name);
												}}
											>
												<span className="flex items-center gap-2 truncate">
													<Folder
														className={`size-4 shrink-0 ${item.kind === "file" ? "opacity-40" : ""}`}
													/>
													{item.name}
												</span>
												<span className="shrink-0 text-xs text-muted-foreground">
													{item.kind === "dir" ? "目录" : formatSize(item.size)}
												</span>
											</div>
										);
									})}
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
						className="absolute z-50 min-w-36 rounded-lg border border-border bg-popover p-1 shadow-lg"
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
			className={`w-full rounded px-3 py-1.5 text-left text-sm ${danger ? "text-red-400 hover:bg-red-500/10" : "hover:bg-accent"}`}
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
	const [saving, setSaving] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const controller = new AbortController();
		setMessage("");
		sdk.files
			.readText(clientId, rootDir, path, 262144, controller.signal)
			.then((result) => setContent(result.content))
			.catch((reason: unknown) => {
				const code =
					typeof reason === "object" && reason !== null && "errorCode" in reason
						? String(reason.errorCode)
						: "";
				setMessage(
					code === "SIZE_EXCEEDED"
						? "文本超过 256 KiB，请使用导出下载"
						: "无法读取文件内容",
				);
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
				<div className="flex-1 overflow-hidden">
					{message ? (
						<div className="flex items-center justify-center p-12">
							<p role="alert" className="text-sm text-amber-400">
								{message}
							</p>
						</div>
					) : (
						<textarea
							ref={textareaRef}
							className="h-full w-full resize-none bg-transparent p-4 font-mono text-sm leading-relaxed outline-none"
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
