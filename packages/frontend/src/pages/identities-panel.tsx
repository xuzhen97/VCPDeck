import type { IdentityInfo } from "@vcpdeck/shared";
import { useCallback, useState, type FormEvent } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function IdentitiesPanel() {
	const sdk = useSdk();
	const load = useCallback((signal: AbortSignal) => sdk.identities.list(signal), [sdk]);
	const resource = useResource(load);
	const [username, setUsername] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [disabling, setDisabling] = useState<IdentityInfo>();

	async function create(event: FormEvent) {
		event.preventDefault();
		await sdk.identities.create({ username, displayName, password });
		setUsername(""); setDisplayName(""); setPassword(""); resource.reload();
	}
	async function disable() { if (!disabling) return; await sdk.identities.disable(disabling.id); setDisabling(undefined); resource.reload(); }
	async function enable(identity: IdentityInfo) { await sdk.identities.enable(identity.id); resource.reload(); }

	if (resource.loading) return <LoadingState label="正在加载身份…" />;
	if (resource.error) return <ErrorState message="无法加载身份" onRetry={resource.reload} />;
	return <div className="space-y-5"><Card><CardHeader><CardTitle>创建身份</CardTitle></CardHeader><CardContent><form className="grid max-w-2xl gap-4 sm:grid-cols-3" onSubmit={create}><div><Label htmlFor="identity-username">用户名</Label><Input id="identity-username" value={username} onChange={(event) => setUsername(event.target.value)} required /></div><div><Label htmlFor="identity-name">显示名</Label><Input id="identity-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></div><div><Label htmlFor="identity-password">初始密码</Label><Input id="identity-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div><Button type="submit">创建身份</Button></form></CardContent></Card><Card><CardHeader><CardTitle>身份列表</CardTitle></CardHeader><CardContent>{resource.data?.map((identity) => <article key={identity.id} className="flex items-center justify-between border-b border-border/60 py-4"><div><p className="font-medium">{identity.displayName} <span className="text-sm text-muted-foreground">@{identity.username}</span></p><p className="text-xs text-muted-foreground">{identity.disabledAt ? "已禁用" : "已启用"}</p></div>{identity.disabledAt ? <Button variant="outline" onClick={() => enable(identity)}>启用</Button> : <Button variant="destructive" onClick={() => setDisabling(identity)}>禁用</Button>}</article>)}</CardContent></Card><Dialog open={Boolean(disabling)} onOpenChange={(open) => { if (!open) setDisabling(undefined); }}><DialogContent><DialogTitle>禁用身份？</DialogTitle><DialogDescription>该身份的会话和 Token 将无法继续访问。</DialogDescription><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setDisabling(undefined)}>取消</Button><Button variant="destructive" onClick={disable}>确认禁用</Button></div></DialogContent></Dialog></div>;
}
