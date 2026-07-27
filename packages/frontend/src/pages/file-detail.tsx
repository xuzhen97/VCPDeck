import type { FileListResult } from "@vcpdeck/shared";
import { useEffect, useState } from "react";
import { useSdk } from "@/api/context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type FileEntry = FileListResult["entries"][number];

export function FileDetail({ clientId, rootDir, path, entry, onDelete, onMove, onChanged }: { clientId: string; rootDir: string; path: string; entry?: FileEntry; onDelete: () => void; onMove: () => void; onChanged: () => void }) {
	const sdk = useSdk();
	const [content, setContent] = useState("");
	const [message, setMessage] = useState("");
	const relativePath = path === "." ? entry?.name ?? "" : `${path}/${entry?.name ?? ""}`;
	useEffect(() => {
		if (!entry || entry.kind !== "file") { setContent(""); setMessage(""); return; }
		const controller = new AbortController();
		sdk.files.readText(clientId, rootDir, relativePath, 262144, controller.signal).then((result) => setContent(result.content)).catch((reason: unknown) => {
			const code = typeof reason === "object" && reason !== null && "errorCode" in reason ? String(reason.errorCode) : "";
			setMessage(code === "SIZE_EXCEEDED" ? "文本超过 256 KiB，请使用导出下载" : "无法读取文件内容");
		});
		return () => controller.abort();
	}, [clientId, entry, relativePath, rootDir, sdk]);
	if (!entry) return <Card><CardContent className="pt-6 text-sm text-muted-foreground">选择文件或目录查看详情</CardContent></Card>;
	return <Card><CardHeader><CardTitle>{entry.name}</CardTitle></CardHeader><CardContent className="space-y-4"><dl className="grid grid-cols-2 gap-3 text-sm"><dt className="text-muted-foreground">类型</dt><dd>{entry.kind}</dd><dt className="text-muted-foreground">大小</dt><dd>{entry.size} bytes</dd><dt className="text-muted-foreground">修改时间</dt><dd>{entry.mtime}</dd></dl>{message && <p role="alert" className="text-sm text-amber-400">{message}</p>}{entry.kind === "file" && !message && <textarea aria-label="文件内容" className="min-h-52 w-full rounded-lg border border-input bg-background/60 p-3 font-mono text-sm" value={content} onChange={(event) => setContent(event.target.value)} />}<div className="flex flex-wrap gap-2">{entry.kind === "file" && <Button variant="outline" onClick={async () => { await sdk.files.writeText(clientId, { rootDir, path: relativePath, content }); onChanged(); }}>保存</Button>}<Button variant="outline" onClick={async () => { const exported = await sdk.files.export(clientId, { rootDir, path: relativePath }); const token = await sdk.storage.createDownloadToken({ key: exported.key }); const anchor = document.createElement("a"); anchor.href = token.url; anchor.download = entry.name; document.body.append(anchor); anchor.click(); anchor.remove(); }}>导出下载</Button><Button variant="outline" onClick={onMove}>移动</Button><Button variant="destructive" onClick={onDelete}>删除</Button></div></CardContent></Card>;
}
