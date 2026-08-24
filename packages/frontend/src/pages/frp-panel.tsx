import type {
	ClientInfo,
	FrpMappingInfo,
	FrpsInstanceInfo,
} from "@vcpdeck/shared";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type FormEvent,
	type ReactNode,
} from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ConfirmTargetDialog } from "@/components/confirm-target-dialog";
import { ErrorState, LoadingState } from "@/components/async-state";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FrpActionMenu } from "./frp-action-menu";
import { Plus } from "lucide-react";

export function FrpPanel({ clientId }: { clientId?: string }) {
	const sdk = useSdk();
	const [page, setPage] = useState(1);
	const load = useCallback(
		(signal: AbortSignal) =>
			sdk.frp.list({ clientId, page, pageSize: 20 }, signal),
		[clientId, page, sdk],
	);
	const resource = useResource(load);
	const controller = useRef<AbortController>();
	const instanceController = useRef<AbortController>();
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [instances, setInstances] = useState<FrpsInstanceInfo[]>([]);
	const [instancesLoading, setInstancesLoading] = useState(false);
	const [instancesError, setInstancesError] = useState(false);
	const [clients, setClients] = useState<ClientInfo[]>([]);
	const [clientsError, setClientsError] = useState(false);
	const [frpsInstanceId, setFrpsInstanceId] = useState("");
	const [name, setName] = useState("");
	const [targetClientId, setTargetClientId] = useState(clientId ?? "");
	const [proxyType, setProxyType] = useState<"tcp" | "http" | "https">("tcp");
	const [localIp, setLocalIp] = useState("127.0.0.1");
	const [localPort, setLocalPort] = useState("");
	const [remotePort, setRemotePort] = useState("");
	const [customDomain, setCustomDomain] = useState("");
	const [created, setCreated] = useState<FrpMappingInfo>();
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState("");
	const [copiedId, setCopiedId] = useState("");
	const [copyErrorId, setCopyErrorId] = useState("");
	const [deleting, setDeleting] = useState<FrpMappingInfo>();
	const [notice, setNotice] = useState("");
	useEffect(
		() => () => {
			controller.current?.abort();
			instanceController.current?.abort();
		},
		[],
	);

	useEffect(() => {
		const controller = new AbortController();
		setClientsError(false);
		sdk.clients
			.list(controller.signal)
			.then(setClients)
			.catch(() => {
				if (!controller.signal.aborted) setClientsError(true);
			});
		return () => controller.abort();
	}, [sdk]);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setCreating(true);
		setCreateError("");
		setCreated(undefined);
		controller.current?.abort();
		const next = new AbortController();
		controller.current = next;
		try {
			const mapping = await sdk.frp.createAndWait(
				{
					clientId: targetClientId,
					...(name ? { name } : {}),
					proxyType,
					localIp,
					localPort: Number(localPort),
					...(frpsInstanceId ? { frpsInstanceId } : {}),
					...(proxyType === "tcp" && remotePort
						? { remotePort: Number(remotePort) }
						: {}),
					...(proxyType !== "tcp" && customDomain ? { customDomain } : {}),
					timeoutSeconds: 30,
				},
				{ signal: next.signal },
			);
			setCreated(mapping);
			setCreating(false);
			setDrawerOpen(false);
			resetForm();
			resource.reload();
		} catch (error) {
			if (!next.signal.aborted) {
				setCreating(false);
				setCreateError(error instanceof Error ? error.message : "创建映射失败");
			}
		}
	}

	function resetForm() {
		setName("");
		setProxyType("tcp");
		setLocalIp("127.0.0.1");
		setLocalPort("");
		setRemotePort("");
		setCustomDomain("");
		setCreated(undefined);
		setCreateError("");
		setFrpsInstanceId("");
	}

	async function openDrawer() {
		setTargetClientId(clientId ?? "");
		resetForm();
		setCreating(false);
		setDrawerOpen(true);
		setInstances([]);
		setInstancesError(false);
		setInstancesLoading(true);
		instanceController.current?.abort();
		const next = new AbortController();
		instanceController.current = next;
		try {
			const result = await sdk.frp.instances.list(
				{ page: 1, pageSize: 100 },
				next.signal,
			);
			setInstances(result.data);
			setFrpsInstanceId(
				result.data.find((instance) => instance.isDefault)?.id ?? "",
			);
		} catch {
			if (!next.signal.aborted) setInstancesError(true);
		} finally {
			if (!next.signal.aborted) setInstancesLoading(false);
		}
	}

	async function remove() {
		if (!deleting) return;
		await sdk.frp.deleteAndWait(deleting.id, { timeoutSeconds: 30 });
		setDeleting(undefined);
		setNotice("映射已从 Client 与 FRPS 删除");
		resource.reload();
	}

	async function copyPublicUrl(mapping: FrpMappingInfo) {
		if (!mapping.publicUrl) return;
		try {
			await navigator.clipboard.writeText(mapping.publicUrl);
			setCopiedId(mapping.id);
			setCopyErrorId("");
		} catch {
			setCopyErrorId(mapping.id);
			setCopiedId("");
		}
	}

	const clientNames = new Map(
		clients.map((client) => [client.clientId, client.name ?? client.hostname]),
	);

	if (resource.loading) return <LoadingState label="正在加载映射…" />;
	if (resource.error)
		return <ErrorState message="无法加载映射" onRetry={resource.reload} />;
	return (
		<>
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>{clientId ? "机器映射" : "全部映射"}</CardTitle>
						<Button size="sm" onClick={openDrawer}>
							<Plus className="mr-1 size-4" />
							新增映射
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					{notice && (
						<p
							role="status"
							className="mb-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300"
						>
							{notice}
						</p>
					)}
					{!resource.data || resource.data.data.length === 0 ? (
						<p className="text-sm text-muted-foreground">暂无映射</p>
					) : (
						<>
							<div className="overflow-visible rounded-2xl border border-border/70 bg-background/40">
								<div className="hidden grid-cols-[1.15fr_1.1fr_.55fr_.75fr_1.05fr_1.15fr_3rem] gap-3 border-b border-border/60 bg-secondary/40 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
									<span>映射</span>
									<span>Client</span>
									<span>类型</span>
									<span>状态</span>
									<span>本地端点</span>
									<span>公网端点</span>
									<span />
								</div>
								<div className="divide-y divide-border/60">
									{resource.data.data.map((mapping) => {
										const clientName = clientNames.get(mapping.clientId);
										const displayName = clientName ?? "未知 Client";
										const localEndpoint = `${mapping.localIp}:${mapping.localPort}`;
										const publicEndpoint = mapping.publicUrl ?? "等待分配";
										return (
											<article key={mapping.id} className="px-4 py-4">
												<div className="hidden items-center gap-3 md:grid md:grid-cols-[1.15fr_1.1fr_.55fr_.75fr_1.05fr_1.15fr_3rem]">
													<div>
														<h3 className="font-medium">{mapping.name}</h3>
														{copiedId === mapping.id && (
															<p className="mt-1 text-xs text-emerald-400">
																已复制
															</p>
														)}
														{copyErrorId === mapping.id && (
															<p className="mt-1 text-xs text-red-400">
																复制失败
															</p>
														)}
													</div>
													<div>
														<p className="font-medium">{displayName}</p>
														<p className="mt-1 font-mono text-xs text-muted-foreground">
															{shortId(mapping.clientId)}
														</p>
													</div>
													<div>
														<StatusChip
															label={mapping.proxyType.toUpperCase()}
														/>
													</div>
													<div>
														<StatusChip
															label={statusLabel(mapping.status)}
															tone={statusTone(mapping.status)}
														/>
													</div>
													<code className="text-sm">{localEndpoint}</code>
													<code className="text-sm">{publicEndpoint}</code>
													<FrpActionMenu
														items={[
															{
																label: "复制公网地址",
																disabled: !mapping.publicUrl,
																onSelect: () => copyPublicUrl(mapping),
															},
															{
																label: "删除映射",
																tone: "danger",
																onSelect: () => setDeleting(mapping),
															},
														]}
													/>
												</div>
												<div className="space-y-3 md:hidden">
													<div className="flex items-start justify-between gap-3">
														<div>
															<div className="flex items-center gap-2">
																<h3 className="font-medium">{mapping.name}</h3>
																<StatusChip
																	label={statusLabel(mapping.status)}
																	tone={statusTone(mapping.status)}
																/>
															</div>
															<p className="mt-1 text-sm text-muted-foreground">
																{displayName} ·{" "}
																{mapping.proxyType.toUpperCase()}
															</p>
															<p className="font-mono text-xs text-muted-foreground">
																{shortId(mapping.clientId)}
															</p>
														</div>
														<FrpActionMenu
															items={[
																{
																	label: "复制公网地址",
																	disabled: !mapping.publicUrl,
																	onSelect: () => copyPublicUrl(mapping),
																},
																{
																	label: "删除映射",
																	tone: "danger",
																	onSelect: () => setDeleting(mapping),
																},
															]}
														/>
													</div>
													<div className="flex flex-wrap gap-2">
														<StatusChip
															label={mapping.proxyType.toUpperCase()}
														/>
														<code className="text-sm">{localEndpoint}</code>
														<span className="text-muted-foreground">→</span>
														<code className="text-sm">{publicEndpoint}</code>
													</div>
													{copiedId === mapping.id && (
														<p className="text-xs text-emerald-400">已复制</p>
													)}
													{copyErrorId === mapping.id && (
														<p className="text-xs text-red-400">复制失败</p>
													)}
													{clientsError && !clientName && (
														<p className="text-xs text-muted-foreground">
															Client 名称加载失败
														</p>
													)}
												</div>
											</article>
										);
									})}
								</div>
							</div>
							<div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
								<span>共 {resource.data.total} 条映射</span>
								{(resource.data.totalPages ?? 0) > 1 && (
									<div className="flex gap-2">
										<Button
											size="sm"
											variant="outline"
											disabled={page <= 1}
											onClick={() => setPage((p) => p - 1)}
										>
											上一页
										</Button>
										<Button
											size="sm"
											variant="outline"
											disabled={page >= (resource.data.totalPages ?? 1)}
											onClick={() => setPage((p) => p + 1)}
										>
											下一页
										</Button>
									</div>
								)}
							</div>
						</>
					)}
				</CardContent>
			</Card>
			<Drawer
				open={drawerOpen}
				onClose={() => setDrawerOpen(false)}
				title="创建映射"
				size="wide"
			>
				<form className="space-y-4" onSubmit={submit}>
					<FormSection title="目标">
						{!clientId && (
							<div className="space-y-2">
								<Label htmlFor="frp-client">Client ID</Label>
								<Input
									id="frp-client"
									value={targetClientId}
									onChange={(event) => setTargetClientId(event.target.value)}
									required
								/>
							</div>
						)}
						<div className="space-y-2">
							<Label htmlFor="frp-name">映射名称（可选）</Label>
							<Input
								id="frp-name"
								aria-label="映射名称（可选）"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="留空时按类型和本地端口生成"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="frps-instance">frps 实例</Label>
							<select
								id="frps-instance"
								className="h-11 w-full rounded-lg border border-input bg-background/60 px-3"
								value={frpsInstanceId}
								onChange={(event) => setFrpsInstanceId(event.target.value)}
								disabled={instancesLoading}
							>
								<option value="">使用服务端默认实例</option>
								{instances.map((instance) => (
									<option key={instance.id} value={instance.id}>
										{instance.name}
										{instance.isDefault ? "（默认）" : ""}
									</option>
								))}
							</select>
							{instancesLoading && (
								<p className="text-sm text-muted-foreground">正在加载实例…</p>
							)}
							{instancesError && (
								<p role="alert" className="text-sm text-amber-400">
									无法加载 frps 实例，将使用服务端默认实例
								</p>
							)}
							{instances
								.filter((instance) => instance.id === frpsInstanceId)
								.map((instance) => (
									<p
										key={instance.id}
										className="text-sm text-muted-foreground"
									>
										{instance.serverAddr}:{instance.serverPort} · 端口范围{" "}
										{instance.portRangeStart}–{instance.portRangeEnd}
									</p>
								))}
						</div>
					</FormSection>
					<FormSection title="本地服务">
						<div className="space-y-2">
							<Label htmlFor="proxy-type">代理类型</Label>
							<select
								id="proxy-type"
								className="h-11 w-full rounded-lg border border-input bg-background/60 px-3"
								value={proxyType}
								onChange={(event) =>
									setProxyType(event.target.value as typeof proxyType)
								}
							>
								<option value="tcp">TCP</option>
								<option value="http">HTTP</option>
								<option value="https">HTTPS</option>
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="local-ip">本地 IP</Label>
							<Input
								id="local-ip"
								value={localIp}
								onChange={(event) => setLocalIp(event.target.value)}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="local-port">本地端口</Label>
							<Input
								id="local-port"
								type="number"
								min="1"
								max="65535"
								value={localPort}
								onChange={(event) => setLocalPort(event.target.value)}
								required
							/>
						</div>
					</FormSection>
					<FormSection title="公网入口">
						{proxyType === "tcp" && (
							<div className="space-y-2">
								<Label htmlFor="remote-port">公网端口（可选）</Label>
								<Input
									id="remote-port"
									type="number"
									min="1"
									max="65535"
									value={remotePort}
									onChange={(event) => setRemotePort(event.target.value)}
								/>
							</div>
						)}
						{proxyType !== "tcp" && (
							<div className="space-y-2">
								<Label htmlFor="custom-domain">自定义域名</Label>
								<Input
									id="custom-domain"
									value={customDomain}
									onChange={(event) => setCustomDomain(event.target.value)}
								/>
							</div>
						)}
					</FormSection>
					{createError && (
						<p role="alert" className="text-sm text-red-400">
							{createError}
						</p>
					)}
					<Button type="submit" disabled={creating}>
						{creating ? "创建中…" : "创建映射"}
					</Button>
					{created && (
						<p className="text-sm">
							状态：
							<StatusChip
								label={created.status}
								tone={
									created.status === "active"
										? "success"
										: created.status === "error"
											? "danger"
											: "warning"
								}
							/>
						</p>
					)}
				</form>
			</Drawer>
			{deleting && (
				<ConfirmTargetDialog
					open
					target={deleting.name}
					title="删除映射"
					onOpenChange={(open) => {
						if (!open) setDeleting(undefined);
					}}
					onConfirm={remove}
				/>
			)}
		</>
	);
}

function FormSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="grid gap-4 rounded-2xl border border-border/60 bg-background/35 p-4 md:grid-cols-2">
			<h3 className="text-sm font-semibold text-muted-foreground md:col-span-2">
				{title}
			</h3>
			{children}
		</section>
	);
}

function shortId(value: string) {
	return `${value.slice(0, 8)}…`;
}

function statusLabel(status: string) {
	return status === "active"
		? "运行中"
		: status === "provisioning"
			? "创建中"
			: status === "deleting"
				? "删除中"
				: status === "error"
					? "异常"
					: "未确认";
}

function statusTone(status: string): "success" | "warning" | "danger" {
	return status === "active"
		? "success"
		: status === "error"
			? "danger"
			: "warning";
}
