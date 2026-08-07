import { useCallback, useEffect, useState } from "react";
import type { PiCwdRef } from "@vcpdeck/shared";
import { Button } from "@/components/ui/button";

const RECENT_KEY = "vcpdeck:pi-recent-projects";
const MAX_RECENT = 10;

export interface RecentProject extends PiCwdRef {
	clientId: string;
}

export interface PiFilesApiLike {
	roots(clientId: string, signal?: AbortSignal): Promise<string[]>;
	list(
		clientId: string,
		rootDir: string,
		path: string,
		signal?: AbortSignal,
	): Promise<{
		entries: Array<{ name: string; kind: "file" | "dir" }>;
	}>;
}

function loadRecent(): RecentProject[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(r): r is RecentProject =>
				typeof r === "object" &&
				r !== null &&
				typeof (r as RecentProject).clientId === "string" &&
				typeof (r as RecentProject).rootDir === "string" &&
				typeof (r as RecentProject).relativePath === "string",
		);
	} catch {
		return [];
	}
}

function saveRecent(projects: RecentProject[]): void {
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(projects.slice(0, MAX_RECENT)));
	} catch {
		// 忽略 localStorage 配额错误
	}
}

function keyOf(p: RecentProject): string {
	return `${p.clientId}\u0000${p.rootDir}\u0000${p.relativePath}`;
}

/**
 * 项目选择器：复用 Files roots/list 浏览目录（不接受自由路径）。
 * 最近项目按机器分组、限量存 localStorage；重新选择时由 Client canonical 校验。
 */
export function PiProjectPicker({
	files,
	clientId,
	value,
	onSelect,
}: {
	files: PiFilesApiLike;
	clientId: string;
	value: PiCwdRef | null;
	onSelect: (ref: PiCwdRef) => void;
}) {
	const [roots, setRoots] = useState<string[]>([]);
	const [root, setRoot] = useState<string | null>(null);
	const [entries, setEntries] = useState<Array<{ name: string; kind: "file" | "dir" }>>([]);
	const [path, setPath] = useState("");
	const [recent, setRecent] = useState<RecentProject[]>(() => loadRecent());
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void files
			.roots(clientId)
			.then((result) => {
				if (!cancelled) setRoots(result);
			})
			.catch(() => {
				if (!cancelled) setRoots([]);
			});
		return () => {
			cancelled = true;
		};
	}, [open, clientId, files]);

	const listDir = useCallback(
		async (dirRoot: string, dirPath: string): Promise<void> => {
			try {
				const result = await files.list(clientId, dirRoot, dirPath);
				setEntries(result.entries);
				setRoot(dirRoot);
				setPath(dirPath);
			} catch {
				setEntries([]);
			}
		},
		[files, clientId],
	);

	const selectCurrent = useCallback(() => {
		if (!root) return;
		const ref: PiCwdRef = { rootDir: root, relativePath: path };
		onSelect(ref);
		setRecent((prev) => {
			const entry: RecentProject = { clientId, ...ref };
			const next = [entry, ...prev.filter((p) => keyOf(p) !== keyOf(entry))];
			saveRecent(next);
			return next;
		});
		setOpen(false);
	}, [root, path, onSelect, clientId]);

	const pickRecent = useCallback(
		(project: RecentProject) => {
			if (project.clientId !== clientId) return;
			onSelect({ rootDir: project.rootDir, relativePath: project.relativePath });
			setOpen(false);
		},
		[clientId, onSelect],
	);

	const myRecent = recent.filter((p) => p.clientId === clientId);
	const parentPath = path.split("/").filter(Boolean).slice(0, -1).join("/");

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<div
					className="min-w-0 flex-1 truncate rounded border border-border bg-secondary/40 px-2 py-1 text-xs"
					title={value ? `${value.rootDir}/${value.relativePath}` : undefined}
				>
					{value ? `${value.rootDir}/${value.relativePath}` : "未选择项目"}
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setOpen((v) => !v)}
				>
					选择
				</Button>
			</div>

			{open && (
				<div className="space-y-2 rounded border border-border p-2">
					<div className="text-xs font-medium text-muted-foreground">最近项目</div>
					{myRecent.length === 0 && (
						<div className="text-xs text-muted-foreground">暂无最近项目</div>
					)}
					<div className="space-y-1">
						{myRecent.map((p) => (
							<button
								key={keyOf(p)}
								type="button"
								className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-secondary/60"
								onClick={() => pickRecent(p)}
							>
								{p.rootDir}/{p.relativePath}
							</button>
						))}
					</div>

					<div className="text-xs font-medium text-muted-foreground">浏览目录</div>
					<div className="flex flex-wrap gap-1">
						{roots.map((r) => (
							<button
								key={r}
								type="button"
								className={`rounded px-2 py-0.5 text-xs ${
									r === root ? "bg-primary text-primary-foreground" : "bg-secondary/60"
								}`}
								onClick={() => void listDir(r, "")}
							>
								{r}
							</button>
						))}
					</div>
					{root && (
						<div className="text-xs">
							<button
								type="button"
								className="text-blue-500"
								onClick={() => void listDir(root, parentPath)}
							>
								↑ 上级
							</button>
							<span className="ml-2 text-muted-foreground">{path || "/"}</span>
						</div>
					)}
					<div className="max-h-40 space-y-1 overflow-y-auto">
						{entries
							.filter((e) => e.kind === "dir")
							.map((e) => (
								<button
									key={e.name}
									type="button"
									className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-secondary/60"
									onClick={() => void listDir(root!, path ? `${path}/${e.name}` : e.name)}
								>
									📁 {e.name}
								</button>
							))}
					</div>
					{root && (
						<Button type="button" size="sm" onClick={selectCurrent}>
							选择此目录
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
