import type { CreateTokenResponse, TokenInfo } from "@vcpdeck/shared";
import { useCallback, useState, type FormEvent } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TokensPanel() {
	const sdk = useSdk();
	const load = useCallback((signal: AbortSignal) => sdk.auth.tokens.list(signal), [sdk]);
	const resource = useResource(load);
	const [label, setLabel] = useState("");
	const [created, setCreated] = useState<CreateTokenResponse>();
	const [revoking, setRevoking] = useState<TokenInfo>();

	async function create(event: FormEvent) {
		event.preventDefault();
		setCreated(await sdk.auth.tokens.create({ label }));
		setLabel("");
		resource.reload();
	}

	async function revoke() {
		if (!revoking) return;
		await sdk.auth.tokens.revoke(revoking.id);
		setRevoking(undefined);
		resource.reload();
	}

	if (resource.loading) return <LoadingState label="正在加载 Token…" />;
	if (resource.error) return <ErrorState message="无法加载 Token" onRetry={resource.reload} />;
	return <div className="space-y-5"><Card><CardHeader><CardTitle>创建 CLI Token</CardTitle></CardHeader><CardContent><form className="flex max-w-xl gap-2" onSubmit={create}><div className="flex-1"><Label className="sr-only" htmlFor="token-label">Token 标签</Label><Input id="token-label" value={label} onChange={(event) => setLabel(event.target.value)} required /></div><Button type="submit">创建 Token</Button></form></CardContent></Card><Card><CardHeader><CardTitle>现有 Token</CardTitle></CardHeader><CardContent>{resource.data?.length ? <div className="divide-y divide-border/60">{resource.data.map((token) => <article key={token.id} className="flex items-center justify-between py-4"><div><p className="font-medium">{token.label}</p><p className="text-xs text-muted-foreground">创建于 {token.createdAt}</p></div>{!token.revokedAt && <Button variant="destructive" onClick={() => setRevoking(token)}>撤销 Token</Button>}</article>)}</div> : <p className="text-sm text-muted-foreground">暂无 Token</p>}</CardContent></Card><Dialog open={Boolean(created)} onOpenChange={(open) => { if (!open) setCreated(undefined); }}><DialogContent><DialogTitle>立即保存 Token</DialogTitle><DialogDescription>此 Token 只显示一次，关闭后无法再次查看。</DialogDescription><pre className="mt-4 overflow-x-auto rounded-lg bg-black/30 p-3 text-sm">{created?.token}</pre><div className="mt-5 flex justify-end"><Button onClick={() => setCreated(undefined)}>我已保存</Button></div></DialogContent></Dialog><Dialog open={Boolean(revoking)} onOpenChange={(open) => { if (!open) setRevoking(undefined); }}><DialogContent><DialogTitle>撤销 Token？</DialogTitle><DialogDescription>撤销后使用该 Token 的客户端将无法继续访问。</DialogDescription><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setRevoking(undefined)}>取消</Button><Button variant="destructive" onClick={revoke}>确认撤销</Button></div></DialogContent></Dialog></div>;
}
