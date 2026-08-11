import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PiCwdRef } from "@vcpdeck/shared";
import { Check, ChevronDown, Folder, FolderOpen, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const RECENT_KEY = "vcpdeck:pi-recent-projects";
const DISMISSED_KEY = "vcpdeck:pi-dismissed-roots";
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
		localStorage.setItem(
			RECENT_KEY,
			JSON.stringify(projects.slice(0, MAX_RECENT)),
		);
	} catch {
		// 忽略 localStorage 配额错误
	}
}

/** 从下拉中隐藏的 root 集合（仅记 rootDir 字符串）。 */
function loadDismissed(): string[] {
	try {
		const raw = localStorage.getItem(DISMISSED_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((r): r is string => typeof r === "string");
	} catch {
		return [];
	}
}

function saveDismissed(roots: string[]): void {
	try {
		localStorage.setItem(DISMISSED_KEY, JSON.stringify(roots));
	} catch {
		// 忽略 localStorage 配额错误
	}
}

function keyOf(p: PiCwdRef): string {
	return `${p.rootDir}\u0000${p.relativePath}`;
}

function sameRef(a: PiCwdRef, b: PiCwdRef): boolean {
	return a.rootDir === b.rootDir && a.relativePath === b.relativePath;
}

/** 把 {rootDir, relativePath} 渲染成系统级路径（\\ 或 / 按 rootDir 自适应）。 */
function formatCwdRef(ref: PiCwdRef): string {
	const separator = ref.rootDir.includes("\\") ? "\\" : "/";
	const root = ref.rootDir.replace(/[\\/]+$/, "");
	const relative = ref.relativePath
		.replace(/^[\\/]+|[\\/]+$/g, "")
		.replace(/[\\/]+/g, separator);
	if (!relative)
		return ref.rootDir.endsWith(separator)
			? ref.rootDir
			: `${ref.rootDir}${separator}`;
	return root ? `${root}${separator}${relative}` : `${separator}${relative}`;
}

/** 把任意路径字符串解析回 {rootDir, relativePath}（取最长匹配 rootDir 前缀）。 */
function parsePathString(input: string, roots: string[]): PiCwdRef | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const normalized = trimmed.replace(/[\\/]+/g, "\\");
	const root = roots
		.slice()
		.sort((a, b) => b.length - a.length)
		.find((r) => {
			const rn = r.replace(/[\\/]+$/, "");
			return (
				normalized === rn ||
				normalized.startsWith(rn + "\\") ||
				normalized.toLowerCase().startsWith(rn.toLowerCase() + "\\")
			);
		});
	if (!root) return null;
	const rootNorm = root.replace(/[\\/]+$/, "");
	const relative = normalized.slice(rootNorm.length).replace(/^[\\]+/, "");
	return { rootDir: root, relativePath: relative };
}

/**
 * 项目选择器：扁平列表 = recents ∪ roots()（每个 root 自身可选）；
 * 筛选不区分大小写、子串匹配；底部三动作：默认目录 / 浏览文件夹 / 自定义路径。
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
	const [open, setOpen] = useState(false);
	const [recent, setRecent] = useState<RecentProject[]>(() => loadRecent());
	const [dismissed, setDismissed] = useState<string[]>(() => loadDismissed());
	const [roots, setRoots] = useState<string[]>([]);
	const [filter, setFilter] = useState("");
	const [mode, setMode] = useState<"list" | "browse" | "custom">("list");
	const [customInput, setCustomInput] = useState("");
	const [customError, setCustomError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);

	// 打开时拉 roots
	useEffect(() => {
		if (!open) return;
		const ac = new AbortController();
		files
			.roots(clientId, ac.signal)
			.then((r) => {
				if (!ac.signal.aborted) setRoots(r);
			})
			.catch(() => {
				if (!ac.signal.aborted) setRoots([]);
			});
		return () => ac.abort();
	}, [open, clientId, files]);

	// 点击外部关闭
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	const myRecent = useMemo(
		() => recent.filter((p) => p.clientId === clientId),
		[recent, clientId],
	);

	const dismissedRoots = useMemo(() => new Set(dismissed), [dismissed]);

	/**
	 * 从下拉中隐藏一项：历史项从 recents 移除；root 本身（如 D:\）加进 dismissed。
	 * 都会同步到 localStorage。不会动其他同 root 下的历史项。
	 */
	const dismissItem = useCallback(
		(ref: PiCwdRef) => {
			setRecent((prev) => {
				const next = prev.filter((p) => keyOf(p) !== keyOf(ref));
				if (next.length !== prev.length) saveRecent(next);
				return next;
			});
			// 只有“候选项本身就是某个 root”才加入 dismissed，避免连累同 root 下的历史。
			const isRootEntry =
				ref.relativePath === "" && roots.includes(ref.rootDir);
			if (isRootEntry) {
				setDismissed((prev) => {
					if (prev.includes(ref.rootDir)) return prev;
					const next = [...prev, ref.rootDir];
					saveDismissed(next);
					return next;
				});
			}
		},
		[roots],
	);

	// 扁平候选：recents + roots 自身（去重），按路径排序；隐藏 dismissed roots
	const candidates = useMemo<PiCwdRef[]>(() => {
		const map = new Map<string, PiCwdRef>();
		for (const r of myRecent) {
			if (dismissedRoots.has(r.rootDir)) continue;
			map.set(keyOf(r), r);
		}
		for (const root of roots) {
			if (dismissedRoots.has(root)) continue;
			const ref: PiCwdRef = { rootDir: root, relativePath: "" };
			if (!map.has(keyOf(ref))) map.set(keyOf(ref), ref);
		}
		return [...map.values()].sort((a, b) =>
			formatCwdRef(a).localeCompare(formatCwdRef(b), undefined, {
				sensitivity: "base",
			}),
		);
	}, [myRecent, roots, dismissedRoots]);

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return candidates;
		return candidates.filter((c) => formatCwdRef(c).toLowerCase().includes(q));
	}, [candidates, filter]);

	const commit = useCallback(
		(ref: PiCwdRef) => {
			onSelect(ref);
			setRecent((prev) => {
				const entry: RecentProject = { clientId, ...ref };
				const next = [entry, ...prev.filter((p) => keyOf(p) !== keyOf(entry))];
				saveRecent(next);
				return next;
			});
			setOpen(false);
			setMode("list");
			setFilter("");
			setCustomInput("");
			setCustomError(null);
		},
		[clientId, onSelect],
	);

	const pickDefault = useCallback(() => {
		if (roots.length === 0) return;
		// 默认：当前 cwd 所在 root；否则第一个 root
		const fallback = roots[0];
		if (!value) {
			commit({ rootDir: fallback, relativePath: "" });
			return;
		}
		const matched = roots
			.slice()
			.sort((a, b) => b.length - a.length)
			.find((r) => r === value.rootDir || value.rootDir.startsWith(r));
		commit({
			rootDir: matched ?? fallback,
			relativePath: matched ? value.relativePath : "",
		});
	}, [roots, value, commit]);

	const submitCustom = useCallback(async () => {
		setCustomError(null);
		const parsed = parsePathString(customInput, roots);
		if (!parsed) {
			setCustomError("路径不在已知 root 下");
			return;
		}
		// canonical 校验：调 list 让 Client 真实解析
		try {
			await files.list(clientId, parsed.rootDir, parsed.relativePath);
			commit(parsed);
		} catch {
			setCustomError("Client 无法解析该路径");
		}
	}, [customInput, roots, clientId, files, commit]);

	return (
		<div className="space-y-2" ref={containerRef}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"flex w-full items-center justify-between gap-2 rounded-lg border bg-background/40 px-3 py-2 text-left text-xs transition",
					open
						? "border-ring ring-2 ring-ring/30"
						: "border-border hover:bg-secondary/40",
				)}
				title={value ? formatCwdRef(value) : undefined}
				aria-expanded={open}
				aria-haspopup="dialog"
			>
				<span
					className={cn(
						"min-w-0 truncate font-mono",
						value ? "text-foreground" : "text-muted-foreground",
					)}
				>
					{value ? formatCwdRef(value) : "未选择项目"}
				</span>
				<ChevronDown
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition",
						open && "rotate-180",
					)}
				/>
			</button>

			{open && (
				<div
					role="dialog"
					aria-label="选择项目"
					className="rounded-lg border border-border bg-card p-2 shadow-xl"
				>
					{mode === "list" && (
						<>
							<Input
								autoFocus
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="筛选项目..."
								className="h-9 text-xs"
								aria-label="筛选项目"
							/>
							<div className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
								{filtered.length === 0 && (
									<div className="px-2 py-3 text-center text-xs text-muted-foreground">
										无匹配项目
									</div>
								)}
								{filtered.map((c) => {
									const selected = value ? sameRef(c, value) : false;
									return (
										<div
											key={keyOf(c)}
											className={cn(
												"group flex w-full items-center rounded text-xs transition",
												selected
													? "bg-primary/10"
													: "hover:bg-secondary/70",
											)}
										>
											<button
												type="button"
												onClick={() => commit(c)}
												className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-foreground/90"
												title={formatCwdRef(c)}
											>
												<span className="w-3.5 shrink-0 text-primary">
													{selected ? <Check className="size-3.5" /> : null}
												</span>
												<span className="min-w-0 truncate font-mono">
													{formatCwdRef(c)}
												</span>
											</button>
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													dismissItem(c);
												}}
												aria-label={`从下拉中移除 ${formatCwdRef(c)}`}
												title="从下拉中移除"
												className="mr-1.5 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
											>
												<X className="size-3" />
											</button>
										</div>
									);
								})}
							</div>
							<div className="mt-1 space-y-0.5 border-t border-border/60 pt-1">
								<ActionRow
									icon={<FolderOpen className="size-3.5" />}
									label="使用默认目录"
									disabled={roots.length === 0}
									onClick={pickDefault}
								/>
								<ActionRow
									icon={<Folder className="size-3.5" />}
									label="浏览文件夹..."
									onClick={() => {
										setMode("browse");
										setFilter("");
									}}
								/>
								<ActionRow
									icon={<Plus className="size-3.5" />}
									label="自定义路径..."
									onClick={() => {
										setMode("custom");
										setFilter("");
										setCustomError(null);
									}}
								/>
							</div>
						</>
					)}

					{mode === "browse" && (
						<BrowsePanel
							files={files}
							clientId={clientId}
							roots={roots}
							onPick={commit}
							onBack={() => setMode("list")}
						/>
					)}

					{mode === "custom" && (
						<div className="space-y-2">
							<Input
								autoFocus
								value={customInput}
								onChange={(e) => setCustomInput(e.target.value)}
								placeholder="D:\\path\\to\\project 或 /path/to/project"
								className="h-9 text-xs font-mono"
								aria-label="自定义路径"
								onKeyDown={(e) => {
									if (e.key === "Enter") void submitCustom();
									if (e.key === "Escape") setMode("list");
								}}
							/>
							{customError && (
								<div className="text-xs text-destructive">{customError}</div>
							)}
							<div className="flex justify-end gap-1.5">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => setMode("list")}
								>
									取消
								</Button>
								<Button
									type="button"
									size="sm"
									disabled={!customInput.trim()}
									onClick={() => void submitCustom()}
								>
									选择
								</Button>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function ActionRow({
	icon,
	label,
	onClick,
	disabled,
}: {
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground/90 transition hover:bg-secondary/70 disabled:cursor-not-allowed disabled:opacity-50"
		>
			<span className="w-3.5 shrink-0 text-muted-foreground">{icon}</span>
			<span className="truncate">{label}</span>
		</button>
	);
}

/** 浏览模式：现有 files.list 目录树，保留原本的"逐级下钻"行为 */
function BrowsePanel({
	files,
	clientId,
	roots,
	onPick,
	onBack,
}: {
	files: PiFilesApiLike;
	clientId: string;
	roots: string[];
	onPick: (ref: PiCwdRef) => void;
	onBack: () => void;
}) {
	const [root, setRoot] = useState<string>(roots[0] ?? "");
	const [path, setPath] = useState("");
	const [entries, setEntries] = useState<
		Array<{ name: string; kind: "file" | "dir" }>
	>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (roots.length > 0 && root === "") setRoot(roots[0]);
		const ac = new AbortController();
		setLoading(true);
		files
			.list(clientId, root, "", ac.signal)
			.then((r) => {
				if (!ac.signal.aborted) setEntries(r.entries);
			})
			.catch(() => {
				if (!ac.signal.aborted) setEntries([]);
			})
			.finally(() => {
				if (!ac.signal.aborted) setLoading(false);
			});
		return () => ac.abort();
	}, [root, clientId, files]);

	const enter = useCallback(
		(name: string) => {
			if (!root) return;
			setPath((p) => (p ? `${p}/${name}` : name));
		},
		[root],
	);

	const goUp = useCallback(() => {
		setPath((p) => p.split("/").filter(Boolean).slice(0, -1).join("/"));
	}, []);

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					onClick={onBack}
					className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary/70"
				>
					← 返回
				</button>
				<div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
					{root
						? formatCwdRef({ rootDir: root, relativePath: path })
						: "无 root"}
				</div>
			</div>
			<div className="flex flex-wrap gap-1">
				{roots.map((r) => (
					<button
						key={r}
						type="button"
						onClick={() => {
							setRoot(r);
							setPath("");
						}}
						className={cn(
							"rounded px-2 py-0.5 text-xs transition",
							r === root
								? "bg-primary text-primary-foreground"
								: "bg-secondary/60 hover:bg-secondary",
						)}
					>
						{r}
					</button>
				))}
			</div>
			{root && path && (
				<button
					type="button"
					onClick={goUp}
					className="text-xs text-primary hover:underline"
				>
					↑ 上级
				</button>
			)}
			<div className="max-h-56 space-y-0.5 overflow-y-auto">
				{loading && (
					<div className="px-2 py-2 text-xs text-muted-foreground">加载中…</div>
				)}
				{!loading &&
					entries
						.filter((e) => e.kind === "dir")
						.map((e) => (
							<div
								key={e.name}
								className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-secondary/70"
							>
								<button
									type="button"
									onClick={() => enter(e.name)}
									className="min-w-0 flex-1 truncate text-left"
								>
									📁 {e.name}
								</button>
								<button
									type="button"
									onClick={() => {
										const r: string = root;
										onPick({
											rootDir: r,
											relativePath: path ? `${path}/${e.name}` : e.name,
										});
									}}
									className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10"
								>
									选择
								</button>
							</div>
						))}
			</div>
			{root && (
				<Button
					type="button"
					size="sm"
					className="w-full"
					onClick={() => {
						const r: string = root;
						onPick({ rootDir: r, relativePath: path });
					}}
				>
					选择当前目录
				</Button>
			)}
		</div>
	);
}
