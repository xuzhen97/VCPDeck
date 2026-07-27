import type { FrpMappingInfo } from "@vcpdeck/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ConfirmTargetDialog } from "@/components/confirm-target-dialog";
import { ErrorState, LoadingState } from "@/components/async-state";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function FrpPanel({ clientId }: { clientId?: string }) {
	const sdk = useSdk();
	const load = useCallback((signal: AbortSignal) => sdk.frp.list(clientId, signal), [clientId, sdk]);
	const resource = useResource(load);
	const controller = useRef<AbortController>();
	const [name, setName] = useState("");
	const [targetClientId, setTargetClientId] = useState(clientId ?? "");
	const [proxyType, setProxyType] = useState<"tcp" | "http" | "https">("tcp");
	const [localIp, setLocalIp] = useState("127.0.0.1");
	const [localPort, setLocalPort] = useState("");
	const [remotePort, setRemotePort] = useState("");
	const [customDomain, setCustomDomain] = useState("");
	const [created, setCreated] = useState<FrpMappingInfo>();
	const [deleting, setDeleting] = useState<FrpMappingInfo>();
	const [notice, setNotice] = useState("");

	useEffect(() => () => controller.current?.abort(), []);

	async function submit(event: FormEvent) {
		event.preventDefault();
		controller.current?.abort();
		const next = new AbortController();
		controller.current = next;
		const mapping = await sdk.frp.create({ clientId: targetClientId, name, proxyType, localIp, localPort: Number(localPort), ...(remotePort ? { remotePort: Number(remotePort) } : {}), ...(proxyType !== "tcp" && customDomain ? { customDomain } : {}) }, next.signal);
		setCreated(mapping);
		const terminal = await waitForMapping(mapping, next.signal, sdk.frp.get);
		setCreated(terminal);
		resource.reload();
	}

	async function remove() {
		if (!deleting) return;
		await sdk.frp.delete(deleting.id);
		setDeleting(undefined);
		setNotice("已移除 Server 映射记录；Client 清理状态尚未确认");
		resource.reload();
	}

	if (resource.loading) return <LoadingState label="正在加载 FRP 映射…" />;
	if (resource.error) return <ErrorState message="无法加载 FRP 映射" onRetry={resource.reload} />;
	return <div className="grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
		<Card><CardHeader><CardTitle>创建映射</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}>
			{!clientId && <div className="space-y-2"><Label htmlFor="frp-client">Client ID</Label><Input id="frp-client" value={targetClientId} onChange={(event) => setTargetClientId(event.target.value)} required /></div>}
			<div className="space-y-2"><Label htmlFor="frp-name">映射名称</Label><Input id="frp-name" value={name} onChange={(event) => setName(event.target.value)} required /></div>
			<div className="space-y-2"><Label htmlFor="proxy-type">代理类型</Label><select id="proxy-type" className="h-11 w-full rounded-lg border border-input bg-background/60 px-3" value={proxyType} onChange={(event) => setProxyType(event.target.value as typeof proxyType)}><option value="tcp">TCP</option><option value="http">HTTP</option><option value="https">HTTPS</option></select></div>
			<div className="space-y-2"><Label htmlFor="local-ip">本地 IP</Label><Input id="local-ip" value={localIp} onChange={(event) => setLocalIp(event.target.value)} required /></div>
			<div className="space-y-2"><Label htmlFor="local-port">本地端口</Label><Input id="local-port" type="number" min="1" max="65535" value={localPort} onChange={(event) => setLocalPort(event.target.value)} required /></div>
			<div className="space-y-2"><Label htmlFor="remote-port">公网端口（可选）</Label><Input id="remote-port" type="number" value={remotePort} onChange={(event) => setRemotePort(event.target.value)} /></div>
			{proxyType !== "tcp" && <div className="space-y-2"><Label htmlFor="custom-domain">自定义域名</Label><Input id="custom-domain" value={customDomain} onChange={(event) => setCustomDomain(event.target.value)} /></div>}
			<Button type="submit">创建映射</Button>{created && <p className="text-sm">创建状态：<StatusChip label={created.status} tone={created.status === "active" ? "success" : created.status === "error" ? "danger" : "warning"} /></p>}
		</form></CardContent></Card>
		<Card><CardHeader><CardTitle>{clientId ? "机器映射" : "全部映射"}</CardTitle></CardHeader><CardContent>{notice && <p role="status" className="mb-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">{notice}</p>}{(resource.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">暂无映射</p> : <div className="divide-y divide-border/60">{resource.data?.map((mapping) => <article key={mapping.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><h3 className="font-medium">{mapping.name}</h3><StatusChip label={mapping.status} tone={mapping.status === "active" ? "success" : mapping.status === "error" ? "danger" : "warning"} /></div><p className="mt-1 text-sm text-muted-foreground">{mapping.clientId} · {mapping.localIp}:{mapping.localPort} → {mapping.publicUrl ?? "等待分配"}</p></div><Button variant="destructive" onClick={() => setDeleting(mapping)}>删除映射</Button></article>)}</div>}</CardContent></Card>
		{deleting && <ConfirmTargetDialog open target={deleting.name} title="删除 FRP 映射" onOpenChange={(open) => { if (!open) setDeleting(undefined); }} onConfirm={remove} />}
	</div>;
}

function waitForMapping(initial: FrpMappingInfo, signal: AbortSignal, get: (id: string, signal?: AbortSignal) => Promise<FrpMappingInfo>): Promise<FrpMappingInfo> {
	const delays = [1000, 2000, 5000];
	const startedAt = Date.now();
	async function poll(current: FrpMappingInfo, attempt: number): Promise<FrpMappingInfo> {
		if (current.status !== "inactive" || Date.now() - startedAt >= 60_000) return current;
		await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 5000, signal);
		return get(current.id, signal).then((next) => poll(next, attempt + 1));
	}
	return poll(initial, 0);
}

function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
	});
}
