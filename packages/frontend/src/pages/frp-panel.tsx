import type { FrpMappingInfo, FrpsInstanceInfo } from "@vcpdeck/shared";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type FormEvent,
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
	const [deleting, setDeleting] = useState<FrpMappingInfo>();
	const [notice, setNotice] = useState("");

	useEffect(
		() => () => {
			controller.current?.abort();
			instanceController.current?.abort();
		},
		[],
	);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setCreating(true);
		setCreateError("");
		setCreated(undefined);
		controller.current?.abort();
		const next = new AbortController();
		controller.current = next;
		try {
			const mapping = await sdk.frp.create(
				{
					clientId: targetClientId,
					name,
					proxyType,
					localIp,
					localPort: Number(localPort),
					...(frpsInstanceId ? { frpsInstanceId } : {}),
					...(remotePort ? { remotePort: Number(remotePort) } : {}),
					...(proxyType !== "tcp" && customDomain ? { customDomain } : {}),
				},
				next.signal,
			);
			setCreated(mapping);
			const terminal = await waitForMapping(mapping, next.signal, sdk.frp.get);
			setCreated(terminal);
			setCreating(false);
			if (terminal.status === "active" || terminal.status === "error") {
				setDrawerOpen(false);
				resetForm();
			}
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
		await sdk.frp.delete(deleting.id);
		setDeleting(undefined);
		setNotice("已移除 Server 映射记录；Client 清理状态尚未确认");
		resource.reload();
	}

	if (resource.loading) return <LoadingState label="正在加载 FRP 映射…" />;
	if (resource.error)
		return <ErrorState message="无法加载 FRP 映射" onRetry={resource.reload} />;
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
							<div className="divide-y divide-border/60">
								{resource.data.data.map((mapping) => (
									<article
										key={mapping.id}
										className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
									>
										<div>
											<div className="flex items-center gap-2">
												<h3 className="font-medium">{mapping.name}</h3>
												<StatusChip
													label={mapping.status}
													tone={
														mapping.status === "active"
															? "success"
															: mapping.status === "error"
																? "danger"
																: "warning"
													}
												/>
											</div>
											<p className="mt-1 text-sm text-muted-foreground">
												{mapping.clientId} · {mapping.localIp}:
												{mapping.localPort} → {mapping.publicUrl ?? "等待分配"}
											</p>
										</div>
										<Button
											variant="destructive"
											onClick={() => setDeleting(mapping)}
										>
											删除映射
										</Button>
									</article>
								))}
							</div>
							<div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
								<span>
									共 {resource.data.total} 条，第 {resource.data.page}/
									{resource.data.totalPages} 页
								</span>
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
							</div>
						</>
					)}
				</CardContent>
			</Card>
			<Drawer
				open={drawerOpen}
				onClose={() => setDrawerOpen(false)}
				title="创建映射"
			>
				<form className="space-y-4" onSubmit={submit}>
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
						<Label htmlFor="frp-name">映射名称</Label>
						<Input
							id="frp-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							required
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
								<p key={instance.id} className="text-sm text-muted-foreground">
									{instance.serverAddr}:{instance.serverPort} · 端口范围{" "}
									{instance.portRangeStart}–{instance.portRangeEnd}
								</p>
							))}
					</div>
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
					title="删除 FRP 映射"
					onOpenChange={(open) => {
						if (!open) setDeleting(undefined);
					}}
					onConfirm={remove}
				/>
			)}
		</>
	);
}

function waitForMapping(
	initial: FrpMappingInfo,
	signal: AbortSignal,
	get: (id: string, signal?: AbortSignal) => Promise<FrpMappingInfo>,
): Promise<FrpMappingInfo> {
	const delays = [1000, 2000, 5000];
	const startedAt = Date.now();
	async function poll(
		current: FrpMappingInfo,
		attempt: number,
	): Promise<FrpMappingInfo> {
		if (current.status !== "inactive" || Date.now() - startedAt >= 60_000)
			return current;
		await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 5000, signal);
		return get(current.id, signal).then((next) => poll(next, attempt + 1));
	}
	return poll(initial, 0);
}

function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted)
			return reject(new DOMException("Aborted", "AbortError"));
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}
