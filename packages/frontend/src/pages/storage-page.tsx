import type { AliyunDriveStatus } from "@vcpdeck/sdk";
import { useCallback, useState, type FormEvent } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { StatusChip } from "@/components/status-chip";
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

export function StoragePage() {
	const sdk = useSdk();
	const load = useCallback(
		(signal: AbortSignal) => sdk.aliyundrive.status(signal),
		[sdk],
	);
	const resource = useResource(load);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [transferFolder, setTransferFolder] = useState("VCPDeck");
	const [state, setState] = useState("");
	const [code, setCode] = useState("");
	const [confirmRevoke, setConfirmRevoke] = useState(false);
	const [oauthError, setOauthError] = useState("");

	async function configure(event: FormEvent) {
		event.preventDefault();
		await sdk.aliyundrive.configure({ clientId, clientSecret, transferFolder });
		setClientSecret("");
		resource.reload();
	}

	async function startOAuth() {
		const result = await sdk.aliyundrive.startOAuth();
		const authorizationUrl = safeAuthorizationUrl(
			result.authorizationUrl,
			resource.data?.openapiBase,
		);
		if (!authorizationUrl) {
			setOauthError("授权地址不安全");
			return;
		}
		setOauthError("");
		setState(result.state);
		window.open(authorizationUrl, "_blank", "noopener,noreferrer");
	}

	async function completeOAuth(event: FormEvent) {
		event.preventDefault();
		await sdk.aliyundrive.completeOAuth({ state, code });
		setState("");
		setCode("");
		resource.reload();
	}

	async function revoke() {
		await sdk.aliyundrive.revoke();
		setConfirmRevoke(false);
		resource.reload();
	}

	if (resource.loading) return <LoadingState label="正在加载存储状态…" />;
	if (resource.error || !resource.data)
		return <ErrorState message="无法加载存储状态" onRetry={resource.reload} />;
	const status = resource.data;
	return (
		<div className="space-y-6">
			<PageHeading
				title="存储"
				description="配置 Storage 后端与阿里云盘授权。"
			/>
			<p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
				当前接口非 admin-only，请仅向可信身份开放；页面不会读取或回填原始密钥。
			</p>
			<div className="grid gap-5 xl:grid-cols-2">
				<StatusCard status={status} />
				<Card>
					<CardHeader>
						<CardTitle>Storage 后端</CardTitle>
					</CardHeader>
					<CardContent className="flex gap-2">
						<Button
							variant="outline"
							onClick={() => sdk.storage.setBackend({ kind: "local" })}
						>
							使用本地存储
						</Button>
						<Button
							variant="outline"
							onClick={() => sdk.storage.setBackend({ kind: "alibaba" })}
						>
							使用阿里云盘
						</Button>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>公开配置</CardTitle>
					</CardHeader>
					<CardContent>
						<form className="space-y-4" onSubmit={configure}>
							<div className="space-y-2">
								<Label htmlFor="storage-client-id">Client ID</Label>
								<Input
									id="storage-client-id"
									value={clientId}
									onChange={(event) => setClientId(event.target.value)}
									required
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="storage-client-secret">Client Secret</Label>
								<Input
									id="storage-client-secret"
									type="password"
									value={clientSecret}
									onChange={(event) => setClientSecret(event.target.value)}
									required
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="transfer-folder">传输目录</Label>
								<Input
									id="transfer-folder"
									value={transferFolder}
									onChange={(event) => setTransferFolder(event.target.value)}
								/>
							</div>
							<Button type="submit">保存配置</Button>
						</form>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>OAuth 授权</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{oauthError && (
							<p role="alert" className="text-sm text-red-400">
								{oauthError}
							</p>
						)}
						<Button onClick={startOAuth}>开始授权</Button>
						<form className="space-y-3" onSubmit={completeOAuth}>
							<div className="space-y-2">
								<Label htmlFor="oauth-state">OAuth State</Label>
								<Input
									id="oauth-state"
									value={state}
									onChange={(event) => setState(event.target.value)}
									required
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="oauth-code">授权码</Label>
								<Input
									id="oauth-code"
									value={code}
									onChange={(event) => setCode(event.target.value)}
									required
								/>
							</div>
							<Button type="submit">完成授权</Button>
						</form>
						<Button
							variant="destructive"
							onClick={() => setConfirmRevoke(true)}
						>
							撤销授权
						</Button>
					</CardContent>
				</Card>
			</div>
			<Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
				<DialogContent>
					<DialogTitle>撤销阿里云盘授权？</DialogTitle>
					<DialogDescription>
						后续云端传输将不可用，直至重新授权。
					</DialogDescription>
					<div className="mt-5 flex justify-end gap-2">
						<Button variant="outline" onClick={() => setConfirmRevoke(false)}>
							取消
						</Button>
						<Button variant="destructive" onClick={revoke}>
							确认撤销
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function safeAuthorizationUrl(
	value: string,
	openapiBase?: string,
): string | undefined {
	try {
		const authorizationUrl = new URL(value);
		const configuredBase = new URL(openapiBase ?? "");
		if (
			authorizationUrl.protocol !== "https:" ||
			authorizationUrl.origin !== configuredBase.origin
		)
			return undefined;
		return authorizationUrl.href;
	} catch {
		return undefined;
	}
}

function StatusCard({ status }: { status: AliyunDriveStatus }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>阿里云盘安全状态</CardTitle>
			</CardHeader>
			<CardContent>
				<dl className="grid grid-cols-2 gap-3 text-sm">
					<dt className="text-muted-foreground">已配置</dt>
					<dd>
						<StatusChip
							label={status.configured ? "是" : "否"}
							tone={status.configured ? "success" : "warning"}
						/>
					</dd>
					<dt className="text-muted-foreground">已授权</dt>
					<dd>{status.authorized ? "是" : "否"}</dd>
					<dt className="text-muted-foreground">凭证过期</dt>
					<dd>{status.isExpired ? "是" : "否"}</dd>
					<dt className="text-muted-foreground">Client ID</dt>
					<dd>{status.clientId ?? "—"}</dd>
					<dt className="text-muted-foreground">传输目录</dt>
					<dd>{status.transferFolder}</dd>
					<dt className="text-muted-foreground">Drive ID</dt>
					<dd>{status.driveId ?? "—"}</dd>
					<dt className="text-muted-foreground">过期时间</dt>
					<dd>
						{status.expiresAt
							? new Date(status.expiresAt).toLocaleString()
							: "—"}
					</dd>
				</dl>
			</CardContent>
		</Card>
	);
}
