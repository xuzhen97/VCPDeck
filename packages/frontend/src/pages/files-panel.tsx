import { Folder, FolderPlus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useSdk } from "@/api/context";
import { useFileBrowser } from "@/api/hooks/use-file-browser";
import { ConfirmTargetDialog } from "@/components/confirm-target-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FileDetail } from "@/pages/file-detail";

export function FilesPanel({ clientId }: { clientId: string }) {
	const sdk = useSdk();
	const browser = useFileBrowser(clientId);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmOverwrite, setConfirmOverwrite] = useState(false);
	const [newDirectory, setNewDirectory] = useState("");
	const [destination, setDestination] = useState("");
	const entry = browser.selectedEntry;
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

	return (
		<div className="space-y-4">
			<p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
				文件能力仅面向可信操作者；当前 Client 的 symlink 边界仍有已知风险。
			</p>
			<div className="grid min-h-[34rem] gap-4 xl:grid-cols-[13rem_minmax(18rem,1fr)_minmax(18rem,.8fr)]">
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
							<Button
								size="icon"
								variant="ghost"
								aria-label="刷新目录"
								onClick={browser.refresh}
							>
								<RefreshCw />
							</Button>
						</div>
					</CardHeader>
					<CardContent>
						{browser.error !== undefined && (
							<p role="alert" className="mb-4 text-sm text-red-400">
								无法读取目录
							</p>
						)}
						{browser.selectedRoot && (
							<>
								<div className="mb-4 flex gap-2">
									<Button variant="outline" onClick={browser.up}>
										上一级
									</Button>
									<Input
										aria-label="新目录名称"
										value={newDirectory}
										onChange={(event) => setNewDirectory(event.target.value)}
									/>
									<Button
										variant="outline"
										disabled={!newDirectory.trim()}
										onClick={createDirectory}
									>
										<FolderPlus />
										新建目录
									</Button>
								</div>
								<div className="divide-y divide-border/60">
									{browser.entries.map((item) => (
										<button
											type="button"
											key={item.name}
											className="flex min-h-12 w-full items-center justify-between gap-4 py-3 text-left"
											onDoubleClick={() =>
												item.kind === "dir" && browser.enter(item.name)
											}
											onClick={() => browser.select(item)}
										>
											<span>{item.name}</span>
											<span className="text-xs text-muted-foreground">
												{item.kind === "dir" ? "目录" : `${item.size} B`}
											</span>
										</button>
									))}
								</div>
							</>
						)}
					</CardContent>
				</Card>
				<div>
					{browser.selectedRoot && (
						<>
							<FileDetail
								clientId={clientId}
								rootDir={browser.selectedRoot}
								path={browser.path}
								entry={entry}
								onDelete={() => setConfirmDelete(true)}
								onMove={() => setDestination(relativePath)}
								onChanged={browser.refresh}
							/>
							{entry && destination && (
								<div className="mt-3 flex gap-2">
									<Input
										aria-label="目标路径"
										value={destination}
										onChange={(event) => setDestination(event.target.value)}
									/>
									<Button onClick={() => void moveSelected(false)}>
										确认移动
									</Button>
								</div>
							)}
						</>
					)}
				</div>
			</div>
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
		</div>
	);
}

function joinDisplayPath(root: string, relative: string): string {
	if (!relative) return root;
	const separator = root.includes("\\") ? "\\" : "/";
	return `${root.replace(/[\\/]$/, "")}${separator}${relative.replaceAll("/", separator)}`;
}
