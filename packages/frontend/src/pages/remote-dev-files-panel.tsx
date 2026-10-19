import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@/api/context";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Entry = { name: string; kind: "file" | "dir"; size: number; mtime: string };

/** RDS workspace 固定根只读浏览；不暴露全局 roots。 */
export function RemoteDevFilesPanel({
	clientId,
	workspaceRoot,
}: {
	clientId: string;
	workspaceRoot: string;
}) {
	const sdk = useSdk();
	const [path, setPath] = useState(".");
	const [entries, setEntries] = useState<Entry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [content, setContent] = useState<string | null>(null);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const result = await sdk.files.list(
					clientId,
					workspaceRoot,
					path,
					signal,
				);
				setEntries(result.entries);
				setError(null);
			} catch (cause) {
				const code = (cause as { code?: unknown }).code;
				setError(typeof code === "string" ? code : "无法读取 workspace");
			}
		},
		[sdk, clientId, workspaceRoot, path],
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	if (error) return <ErrorState message={error} onRetry={() => void load()} />;
	if (entries === null) return <LoadingState label="正在读取 workspace…" />;

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle>Files</CardTitle>
				<Button
					variant="outline"
					onClick={() => {
						setContent(null);
						setPath(path === "." ? "." : path.split("/").slice(0, -1).join("/") || ".");
					}}
				>
					上一级
				</Button>
			</CardHeader>
			<CardContent className="space-y-3">
				<p className="text-xs text-muted-foreground">
					{workspaceRoot}/{path}
				</p>
				<div className="divide-y rounded-md border">
					{entries.map((entry) => (
						<button
							key={entry.name}
							type="button"
							className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
							onClick={() => {
								const next = path === "." ? entry.name : `${path}/${entry.name}`;
								if (entry.kind === "dir") {
									setPath(next);
									setContent(null);
									return;
								}
								void sdk.files
									.readText(clientId, workspaceRoot, next)
									.then((result) => setContent(result.content))
									.catch(() => setError("无法读取文件"));
							}}
						>
							<span>
								{entry.kind === "dir" ? "📁" : "📄"} {entry.name}
							</span>
							<span className="text-xs text-muted-foreground">
								{entry.kind === "file" ? `${entry.size} B` : ""}
							</span>
						</button>
					))}
					{entries.length === 0 && (
						<p className="p-3 text-sm text-muted-foreground">目录为空。</p>
					)}
				</div>
				{content !== null && (
					<pre className="max-h-[360px] overflow-auto rounded-md bg-muted p-3 text-xs">
						{content}
					</pre>
				)}
			</CardContent>
		</Card>
	);
}
