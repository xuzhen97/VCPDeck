import type {
	AliyunDriveConfigInput,
	AliyunDriveStatus,
	AliyunDriveVerification,
	StorageBackendKind,
	StorageBackendStatus,
} from "@vcpdeck/sdk";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type FormEvent,
	type KeyboardEvent,
} from "react";
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

const tabs = ["backend", "aliyun"] as const;
type StorageTab = (typeof tabs)[number];

export function StoragePage() {
	const sdk = useSdk();
	const backendLoad = useCallback(
		(signal: AbortSignal) => sdk.storage.getBackendConfig(signal),
		[sdk],
	);
	const backendResource = useResource(backendLoad);
	const aliyunLoad = useCallback(
		(signal: AbortSignal) => sdk.aliyundrive.status(signal),
		[sdk],
	);
	const aliyunResource = useResource(aliyunLoad);
	const [tab, setTab] = useState<StorageTab>("backend");
	const [pendingBackend, setPendingBackend] = useState<StorageBackendKind>();
	const [backendBusy, setBackendBusy] = useState(false);
	const [backendError, setBackendError] = useState("");
	const [notice, setNotice] = useState("");
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [transferFolder, setTransferFolder] = useState("VCPDeck");
	const [configError, setConfigError] = useState("");
	const [configBusy, setConfigBusy] = useState(false);
	const [state, setState] = useState("");
	const [code, setCode] = useState("");
	const [oauthError, setOauthError] = useState("");
	const [oauthBusy, setOauthBusy] = useState(false);
	const [confirmRevoke, setConfirmRevoke] = useState(false);
	const [revokeBusy, setRevokeBusy] = useState(false);
	const [verification, setVerification] = useState<AliyunDriveVerification>();
	const [verificationBusy, setVerificationBusy] = useState(false);
	const configInitialized = useRef(false);
	const verificationAttempted = useRef(false);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

	useEffect(() => {
		const status = aliyunResource.data;
		if (!status || configInitialized.current) return;
		configInitialized.current = true;
		setClientId(status.clientId ?? "");
		setTransferFolder(status.transferFolder);
	}, [aliyunResource.data]);

	function showNotice(message: string) {
		setNotice(message);
		window.setTimeout(() => setNotice(""), 2500);
	}

	function resetVerification() {
		verificationAttempted.current = false;
		setVerification(undefined);
	}

	const verifyAuthorization = useCallback(async () => {
		setVerificationBusy(true);
		try {
			const result = await sdk.aliyundrive.verify();
			setVerification(result);
			if (result.valid && result.driveId) aliyunResource.reload();
		} catch {
			setVerification({
				valid: false,
				checkedAt: new Date().toISOString(),
				reason: "unreachable",
			});
		} finally {
			setVerificationBusy(false);
		}
	}, [aliyunResource, sdk]);

	useEffect(() => {
		if (tab !== "aliyun") {
			verificationAttempted.current = false;
			return;
		}
		if (!verification && !verificationAttempted.current) {
			verificationAttempted.current = true;
			void verifyAuthorization();
		}
	}, [tab, verification, verifyAuthorization]);

	async function switchBackend(kind: StorageBackendKind) {
		setBackendBusy(true);
		setBackendError("");
		setNotice("");
		try {
			await sdk.storage.setBackend({ kind });
			await Promise.all([
				sdk.storage.getBackendConfig(),
				sdk.aliyundrive.status(),
			]);
			backendResource.reload();
			aliyunResource.reload();
			showNotice("存储后端已切换");
		} catch (error) {
			setBackendError(
				error instanceof Error ? error.message : "切换存储后端失败",
			);
		} finally {
			setPendingBackend(undefined);
			setBackendBusy(false);
		}
	}

	function requestBackendSwitch(kind: StorageBackendKind) {
		if (kind === "alibaba" && backendResource.data?.kind !== "alibaba") {
			setPendingBackend(kind);
			return;
		}
		void switchBackend(kind);
	}

	async function configure(event: FormEvent) {
		event.preventDefault();
		setConfigBusy(true);
		setConfigError("");
		try {
			const input: AliyunDriveConfigInput = {
				clientId: clientId.trim(),
				transferFolder: transferFolder.trim(),
			};
			if (clientSecret) input.clientSecret = clientSecret;
			await sdk.aliyundrive.configure(input);
			setClientSecret("");
			resetVerification();
			aliyunResource.reload();
			showNotice("阿里云盘配置已保存");
		} catch (error) {
			setConfigError(error instanceof Error ? error.message : "保存配置失败");
		} finally {
			setConfigBusy(false);
		}
	}

	async function startOAuth() {
		setOauthBusy(true);
		setOauthError("");
		try {
			const result = await sdk.aliyundrive.startOAuth();
			const authorizationUrl = safeAuthorizationUrl(
				result.authorizationUrl,
				aliyunResource.data?.openapiBase,
			);
			if (!authorizationUrl) {
				setOauthError("授权地址不安全");
				return;
			}
			setState(result.state);
			window.open(authorizationUrl, "_blank", "noopener,noreferrer");
		} catch (error) {
			setOauthError(error instanceof Error ? error.message : "无法开始授权");
		} finally {
			setOauthBusy(false);
		}
	}

	async function completeOAuth(event: FormEvent) {
		event.preventDefault();
		setOauthBusy(true);
		setOauthError("");
		try {
			await sdk.aliyundrive.completeOAuth({ state, code });
			setState("");
			setCode("");
			resetVerification();
			aliyunResource.reload();
			showNotice("阿里云盘授权已完成");
		} catch (error) {
			setOauthError(error instanceof Error ? error.message : "完成授权失败");
		} finally {
			setOauthBusy(false);
		}
	}

	async function revoke() {
		setRevokeBusy(true);
		setOauthError("");
		try {
			await sdk.aliyundrive.revoke();
			setConfirmRevoke(false);
			resetVerification();
			aliyunResource.reload();
			showNotice("阿里云盘授权已撤销");
		} catch (error) {
			setOauthError(error instanceof Error ? error.message : "撤销授权失败");
		} finally {
			setRevokeBusy(false);
		}
	}

	function handleTabKeyDown(
		index: number,
		event: KeyboardEvent<HTMLButtonElement>,
	) {
		const direction =
			event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (!direction) return;
		event.preventDefault();
		const next = (index + direction + tabs.length) % tabs.length;
		setTab(tabs[next]);
		tabRefs.current[next]?.focus();
	}

	if (backendResource.loading || !backendResource.data) {
		if (backendResource.error) {
			return (
				<ErrorState
					message="无法加载存储后端状态"
					onRetry={backendResource.reload}
				/>
			);
		}
		return <LoadingState label="正在加载存储状态…" />;
	}

	const backend = backendResource.data;
	const aliyun = aliyunResource.data;
	return (
		<div className="space-y-6">
			<PageHeading
				title="存储"
				description="管理文件传输后端、连接配置与云盘授权。"
			/>
			<p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
				当前接口非 admin-only，请仅向可信身份开放；页面不会读取或回填原始密钥。
			</p>

			<Card className="storage-status-card border-primary/30 bg-primary/5">
				<CardHeader>
					<p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
						当前激活的存储
					</p>
					<CardTitle className="flex items-center gap-3 text-2xl">
						<span
							className={`size-3 rounded-full ${backend.kind === "local" || aliyun?.authorized ? "bg-emerald-500" : "bg-amber-500"}`}
							aria-hidden="true"
						/>
						{backend.kind === "local" ? "本地存储" : "阿里云盘"}
					</CardTitle>
					<p className="text-sm text-muted-foreground" aria-live="polite">
						{activeBackendLabel(backend.kind, aliyun)}
					</p>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex flex-wrap gap-2" aria-busy={backendBusy}>
						<Button
							variant={backend.kind === "local" ? "default" : "outline"}
							disabled={backendBusy || backend.kind === "local"}
							onClick={() => requestBackendSwitch("local")}
						>
							{backendBusy && backend.kind !== "local"
								? "正在切换…"
								: "本地存储"}
						</Button>
						<Button
							variant={backend.kind === "alibaba" ? "default" : "outline"}
							disabled={backendBusy || backend.kind === "alibaba"}
							onClick={() => requestBackendSwitch("alibaba")}
						>
							{backendBusy && backend.kind !== "alibaba"
								? "正在切换…"
								: "阿里云盘"}
						</Button>
					</div>
					<p className="text-sm text-muted-foreground">
						切换只影响新任务，不会自动迁移已有文件。
					</p>
					{backend.kind === "alibaba" && (!aliyun || !aliyun.authorized) && (
						<p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
							阿里云盘已设为当前后端，但尚未完成授权，新的文件操作可能失败。
						</p>
					)}
					{backendError && (
						<p role="alert" className="text-sm text-red-400">
							{backendError}
						</p>
					)}
					{notice && (
						<p
							role="status"
							aria-live="polite"
							className="text-sm text-emerald-500"
						>
							✓ {notice}
						</p>
					)}
				</CardContent>
			</Card>

			<Card>
				<div
					role="tablist"
					aria-label="存储设置"
					className="flex gap-1 overflow-x-auto border-b border-border/70 px-6"
				>
					{[
						["backend", "后端配置"],
						["aliyun", "阿里云盘"],
					].map(([value, label], index) => (
						<button
							key={value}
							ref={(element) => {
								tabRefs.current[index] = element;
							}}
							role="tab"
							id={`storage-tab-${value}`}
							tabIndex={tab === value ? 0 : -1}
							aria-selected={tab === value}
							aria-controls={`storage-panel-${value}`}
							className={`shrink-0 border-b-2 px-4 py-4 text-sm transition ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
							onKeyDown={(event) => handleTabKeyDown(index, event)}
							onClick={() => setTab(value as StorageTab)}
						>
							{label}
						</button>
					))}
				</div>
				<div
					id={`storage-panel-${tab}`}
					role="tabpanel"
					aria-labelledby={`storage-tab-${tab}`}
					className="storage-tab-panel p-6"
				>
					{tab === "backend" && (
						<BackendPanel
							backend={backend}
							aliyun={aliyun}
							onSwitch={requestBackendSwitch}
							busy={backendBusy}
							onOpenTab={setTab}
						/>
					)}
					{tab === "aliyun" && (
						<AlibabaPanel
							clientId={clientId}
							clientSecret={clientSecret}
							transferFolder={transferFolder}
							configBusy={configBusy}
							configError={configError}
							onClientIdChange={setClientId}
							onClientSecretChange={setClientSecret}
							onTransferFolderChange={setTransferFolder}
							onConfigure={configure}
							status={aliyun}
							verification={verification}
							verificationBusy={verificationBusy}
							onVerify={verifyAuthorization}
							oauthError={oauthError}
							oauthBusy={oauthBusy}
							revokeBusy={revokeBusy}
							state={state}
							code={code}
							confirmRevoke={confirmRevoke}
							onStateChange={setState}
							onCodeChange={setCode}
							onStartOAuth={startOAuth}
							onCompleteOAuth={completeOAuth}
							onRequestRevoke={() => setConfirmRevoke(true)}
							onConfirmRevoke={revoke}
							onCancelRevoke={() => setConfirmRevoke(false)}
							onRetry={aliyunResource.reload}
						/>
					)}
				</div>
			</Card>
			<Dialog
				open={pendingBackend === "alibaba"}
				onOpenChange={(open) => !open && setPendingBackend(undefined)}
			>
				<DialogContent>
					<DialogTitle>启用阿里云盘？</DialogTitle>
					<DialogDescription>
						新创建的任务将使用阿里云盘。已有文件不会自动迁移，未完成上传任务将继续使用原后端。
					</DialogDescription>
					<div className="mt-5 flex justify-end gap-2">
						<Button
							variant="outline"
							onClick={() => setPendingBackend(undefined)}
							disabled={backendBusy}
						>
							取消
						</Button>
						<Button
							onClick={() => void switchBackend("alibaba")}
							disabled={backendBusy}
						>
							{backendBusy ? "正在切换…" : "确认切换"}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function activeBackendLabel(
	kind: StorageBackendKind,
	status?: AliyunDriveStatus,
): string {
	if (kind === "local") return "本地存储 · 正常运行";
	if (!status) return "阿里云盘 · 状态不可用";
	if (status.isExpired) return "阿里云盘 · 授权已过期";
	if (!status.authorized) return "阿里云盘 · 尚未授权";
	return "阿里云盘 · 已授权";
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

function BackendPanel({
	backend,
	aliyun,
	onSwitch,
	busy,
	onOpenTab,
}: {
	backend: StorageBackendStatus;
	aliyun?: AliyunDriveStatus;
	onSwitch: (kind: StorageBackendKind) => void;
	busy: boolean;
	onOpenTab: (tab: StorageTab) => void;
}) {
	return (
		<div className="space-y-5">
			<div>
				<h2 className="text-lg font-semibold">选择存储后端</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					当前后端会用于新创建的文件传输任务。
				</p>
			</div>
			<div className="grid gap-4 md:grid-cols-2">
				<BackendOption
					title="本地存储"
					description="文件保存在服务器本机。"
					active={backend.kind === "local"}
					busy={busy}
					onClick={() => onSwitch("local")}
				/>
				<BackendOption
					title="阿里云盘"
					description={
						aliyun?.authorized
							? "已完成 OAuth 授权，可用于云端传输。"
							: "需要先配置并完成 OAuth 授权。"
					}
					active={backend.kind === "alibaba"}
					busy={busy}
					onClick={() => onSwitch("alibaba")}
					onConfigure={() => onOpenTab("aliyun")}
				/>
			</div>
			<p className="text-sm text-muted-foreground">
				切换不会迁移历史文件；未完成的上传任务继续使用创建时的后端。
			</p>
		</div>
	);
}

function BackendOption({
	title,
	description,
	active,
	busy,
	onClick,
	onConfigure,
}: {
	title: string;
	description: string;
	active: boolean;
	busy: boolean;
	onClick: () => void;
	onConfigure?: () => void;
}) {
	return (
		<div
			className={`rounded-xl border p-5 transition ${active ? "border-primary bg-primary/5" : "border-border"}`}
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<h3 className="font-semibold">{title}</h3>
					<p className="mt-2 text-sm text-muted-foreground">{description}</p>
				</div>
				{active && <StatusChip label="当前使用" tone="success" />}
			</div>
			<div className="mt-4 flex flex-wrap gap-2">
				<Button
					size="sm"
					variant={active ? "secondary" : "default"}
					disabled={active || busy}
					onClick={onClick}
				>
					{active ? "当前使用" : `切换到${title}`}
				</Button>
				{onConfigure && (
					<Button size="sm" variant="outline" onClick={onConfigure}>
						去设置
					</Button>
				)}
			</div>
		</div>
	);
}

function AlibabaPanel({
	clientId,
	clientSecret,
	transferFolder,
	configBusy,
	configError,
	onClientIdChange,
	onClientSecretChange,
	onTransferFolderChange,
	onConfigure,
	status,
	verification,
	verificationBusy,
	onVerify,
	oauthError,
	oauthBusy,
	revokeBusy,
	state,
	code,
	confirmRevoke,
	onStateChange,
	onCodeChange,
	onStartOAuth,
	onCompleteOAuth,
	onRequestRevoke,
	onConfirmRevoke,
	onCancelRevoke,
	onRetry,
}: {
	clientId: string;
	clientSecret: string;
	transferFolder: string;
	configBusy: boolean;
	configError: string;
	onClientIdChange: (value: string) => void;
	onClientSecretChange: (value: string) => void;
	onTransferFolderChange: (value: string) => void;
	onConfigure: (event: FormEvent) => void;
	status?: AliyunDriveStatus;
	verification?: AliyunDriveVerification;
	verificationBusy: boolean;
	onVerify: () => void;
	oauthError: string;
	oauthBusy: boolean;
	revokeBusy: boolean;
	state: string;
	code: string;
	confirmRevoke: boolean;
	onStateChange: (value: string) => void;
	onCodeChange: (value: string) => void;
	onStartOAuth: () => void;
	onCompleteOAuth: (event: FormEvent) => void;
	onRequestRevoke: () => void;
	onConfirmRevoke: () => void;
	onCancelRevoke: () => void;
	onRetry: () => void;
}) {
	return (
		<div className="grid gap-6 xl:grid-cols-2">
			<ConfigPanel
				clientId={clientId}
				clientSecret={clientSecret}
				transferFolder={transferFolder}
				busy={configBusy}
				error={configError}
				onClientIdChange={onClientIdChange}
				onClientSecretChange={onClientSecretChange}
				onTransferFolderChange={onTransferFolderChange}
				onSubmit={onConfigure}
			/>
			<SecurityPanel
				status={status}
				verification={verification}
				verificationBusy={verificationBusy}
				onVerify={onVerify}
				error={oauthError}
				busy={oauthBusy}
				revokeBusy={revokeBusy}
				state={state}
				code={code}
				confirmRevoke={confirmRevoke}
				onStateChange={onStateChange}
				onCodeChange={onCodeChange}
				onStartOAuth={onStartOAuth}
				onCompleteOAuth={onCompleteOAuth}
				onRequestRevoke={onRequestRevoke}
				onConfirmRevoke={onConfirmRevoke}
				onCancelRevoke={onCancelRevoke}
				onRetry={onRetry}
			/>
		</div>
	);
}

function ConfigPanel({
	clientId,
	clientSecret,
	transferFolder,
	busy,
	error,
	onClientIdChange,
	onClientSecretChange,
	onTransferFolderChange,
	onSubmit,
}: {
	clientId: string;
	clientSecret: string;
	transferFolder: string;
	busy: boolean;
	error: string;
	onClientIdChange: (value: string) => void;
	onClientSecretChange: (value: string) => void;
	onTransferFolderChange: (value: string) => void;
	onSubmit: (event: FormEvent) => void;
}) {
	return (
		<div className="max-w-2xl space-y-5">
			<div>
				<h2 className="text-lg font-semibold">连接配置</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					配置阿里云盘应用信息和传输目录。Client Secret 留空表示保留已保存的值。
				</p>
			</div>
			<form className="space-y-4" onSubmit={onSubmit}>
				<div className="space-y-2">
					<Label htmlFor="storage-client-id">Client ID</Label>
					<Input
						id="storage-client-id"
						value={clientId}
						onChange={(event) => onClientIdChange(event.target.value)}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="storage-client-secret">Client Secret</Label>
					<Input
						id="storage-client-secret"
						type="password"
						value={clientSecret}
						onChange={(event) => onClientSecretChange(event.target.value)}
						placeholder="留空以保留现有密钥"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="transfer-folder">传输目录</Label>
					<Input
						id="transfer-folder"
						value={transferFolder}
						onChange={(event) => onTransferFolderChange(event.target.value)}
					/>
				</div>
				{error && (
					<p role="alert" className="text-sm text-red-400">
						{error}
					</p>
				)}
				<Button type="submit" disabled={busy}>
					{busy ? "正在保存…" : "保存配置"}
				</Button>
			</form>
		</div>
	);
}

function SecurityPanel({
	status,
	verification,
	verificationBusy,
	onVerify,
	error,
	busy,
	revokeBusy,
	state,
	code,
	confirmRevoke,
	onStateChange,
	onCodeChange,
	onStartOAuth,
	onCompleteOAuth,
	onRequestRevoke,
	onConfirmRevoke,
	onCancelRevoke,
	onRetry,
}: {
	status?: AliyunDriveStatus;
	verification?: AliyunDriveVerification;
	verificationBusy: boolean;
	onVerify: () => void;
	error: string;
	busy: boolean;
	revokeBusy: boolean;
	state: string;
	code: string;
	confirmRevoke: boolean;
	onStateChange: (value: string) => void;
	onCodeChange: (value: string) => void;
	onStartOAuth: () => void;
	onCompleteOAuth: (event: FormEvent) => void;
	onRequestRevoke: () => void;
	onConfirmRevoke: () => void;
	onCancelRevoke: () => void;
	onRetry: () => void;
}) {
	if (!status)
		return <ErrorState message="阿里云盘状态暂时不可用" onRetry={onRetry} />;
	return (
		<div className="max-w-3xl space-y-5">
			<div>
				<h2 className="text-lg font-semibold">授权状态与 OAuth</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					仅展示安全状态摘要，不会读取或回填原始凭证。
				</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<StatusRow
					label="配置状态"
					value={status.configured ? "已配置" : "未配置"}
					tone={status.configured ? "success" : "warning"}
				/>
				<StatusRow
					label="授权状态"
					value={
						status.authorized
							? "已授权"
							: status.isExpired
								? "已过期"
								: "未授权"
					}
					tone={status.authorized ? "success" : "warning"}
				/>
				<StatusRow label="Client ID" value={status.clientId ?? "—"} />
				<StatusRow label="Drive ID" value={status.driveId ?? "—"} />
				<StatusRow label="传输目录" value={status.transferFolder} />
				<StatusRow
					label="过期时间"
					value={
						status.expiresAt ? new Date(status.expiresAt).toLocaleString() : "—"
					}
				/>
			</div>
			<div
				className="rounded-xl border border-border/70 bg-background/30 p-4"
				aria-live="polite"
			>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<p className="text-sm font-medium">远端授权有效性</p>
						<p className="mt-1 text-xs text-muted-foreground">
							{verification?.checkedAt
								? `最近检查：${new Date(verification.checkedAt).toLocaleString()}`
								: "尚未检查"}
						</p>
					</div>
					<StatusChip
						label={
							verificationBusy ? "检查中" : verificationLabel(verification)
						}
						tone={verificationTone(verification, verificationBusy)}
					/>
				</div>
				{verification?.reason === "revoked" ||
				verification?.reason === "forbidden" ? (
					<p className="mt-3 text-sm text-red-400">
						授权已失效，请重新授权。已保存的授权不会自动删除。
					</p>
				) : verification?.reason === "unreachable" ? (
					<p className="mt-3 text-sm text-amber-400">
						无法完成检查，请稍后重试；当前授权状态未被修改。
					</p>
				) : null}
				<Button
					className="mt-3"
					variant="outline"
					onClick={onVerify}
					disabled={verificationBusy}
				>
					{verificationBusy ? "正在检查…" : "立即检查授权"}
				</Button>
			</div>
			{error && (
				<p role="alert" className="text-sm text-red-400">
					{error}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button onClick={onStartOAuth} disabled={busy || !status.configured}>
					{busy ? "正在准备授权…" : "开始授权"}
				</Button>
				<Button
					variant="destructive"
					onClick={onRequestRevoke}
					disabled={revokeBusy || !status.hasAuth}
				>
					{revokeBusy ? "正在撤销…" : "撤销授权"}
				</Button>
			</div>
			<form
				className="space-y-3 rounded-xl border border-border p-4"
				onSubmit={onCompleteOAuth}
			>
				<h3 className="font-medium">完成 OAuth 授权</h3>
				<div className="space-y-2">
					<Label htmlFor="oauth-state">OAuth State</Label>
					<Input
						id="oauth-state"
						value={state}
						onChange={(event) => onStateChange(event.target.value)}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="oauth-code">授权码</Label>
					<Input
						id="oauth-code"
						value={code}
						onChange={(event) => onCodeChange(event.target.value)}
						required
					/>
				</div>
				<Button type="submit" disabled={busy}>
					{busy ? "正在完成…" : "完成授权"}
				</Button>
			</form>
			<Dialog
				open={confirmRevoke}
				onOpenChange={(open) => !open && onCancelRevoke()}
			>
				<DialogContent>
					<DialogTitle>撤销阿里云盘授权？</DialogTitle>
					<DialogDescription>
						后续云端传输将不可用，直至重新授权。
					</DialogDescription>
					<div className="mt-5 flex justify-end gap-2">
						<Button variant="outline" onClick={onCancelRevoke}>
							取消
						</Button>
						<Button
							variant="destructive"
							onClick={onConfirmRevoke}
							disabled={revokeBusy}
						>
							{revokeBusy ? "正在撤销…" : "确认撤销"}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function verificationLabel(verification?: AliyunDriveVerification): string {
	if (!verification) return "未检查";
	if (verification.valid) return "授权有效";
	if (verification.reason === "unreachable") return "无法完成检查";
	if (verification.reason === "not_configured") return "未配置";
	if (verification.reason === "not_authorized") return "未授权";
	if (verification.reason === "expired") return "授权已过期";
	return "授权已失效";
}

function verificationTone(
	verification: AliyunDriveVerification | undefined,
	busy: boolean,
): "success" | "warning" | "danger" | "neutral" {
	if (busy || !verification) return "neutral";
	if (verification.valid) return "success";
	if (verification.reason === "unreachable") return "warning";
	return "danger";
}

function StatusRow({
	label,
	value,
	tone = "neutral",
}: {
	label: string;
	value: string;
	tone?: "success" | "warning" | "neutral";
}) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/30 p-3 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<StatusChip label={value} tone={tone} />
		</div>
	);
}
