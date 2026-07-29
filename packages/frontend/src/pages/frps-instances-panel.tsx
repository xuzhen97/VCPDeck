import type {
	FrpsInstanceCreateRequest,
	FrpsInstanceInfo,
	FrpsInstanceUpdateRequest,
	ProbeResult,
} from "@vcpdeck/shared";
import { Plus } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { ConfirmTargetDialog } from "@/components/confirm-target-dialog";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function FrpsInstancesPanel() {
	const sdk = useSdk();
	const [page, setPage] = useState(1);
	const load = useCallback(
		(signal: AbortSignal) =>
			sdk.frp.instances.list({ page, pageSize: 20 }, signal),
		[page, sdk],
	);
	const resource = useResource(load);
	const [editing, setEditing] = useState<FrpsInstanceInfo>();
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [deleting, setDeleting] = useState<FrpsInstanceInfo>();
	const [saving, setSaving] = useState(false);
	const [actionError, setActionError] = useState("");
	const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
	const [probingId, setProbingId] = useState("");

	async function openEdit(item: FrpsInstanceInfo) {
		setActionError("");
		try {
			setEditing(await sdk.frp.instances.get(item.id));
			setDrawerOpen(true);
		} catch (error) {
			setActionError(message(error, "无法加载实例详情"));
		}
	}

	async function save(
		input: FrpsInstanceCreateRequest | FrpsInstanceUpdateRequest,
	) {
		setSaving(true);
		setActionError("");
		try {
			if (editing) await sdk.frp.instances.update(editing.id, input);
			else await sdk.frp.instances.create(input as FrpsInstanceCreateRequest);
			setDrawerOpen(false);
			setEditing(undefined);
			resource.reload();
		} catch (error) {
			setActionError(message(error, "保存实例失败"));
		} finally {
			setSaving(false);
		}
	}

	async function setDefault(id: string) {
		setActionError("");
		try {
			await sdk.frp.instances.setDefault(id);
			resource.reload();
		} catch (error) {
			setActionError(message(error, "设置默认实例失败"));
		}
	}

	async function probe(id: string) {
		setProbingId(id);
		setActionError("");
		try {
			const result = await sdk.frp.instances.probe(id);
			setProbes((current) => ({ ...current, [id]: result }));
		} catch (error) {
			setActionError(message(error, "健康检查失败"));
		} finally {
			setProbingId("");
		}
	}

	async function remove() {
		if (!deleting) return;
		setActionError("");
		try {
			await sdk.frp.instances.delete(deleting.id);
			setDeleting(undefined);
			resource.reload();
		} catch (error) {
			setActionError(message(error, "删除实例失败"));
		}
	}

	if (resource.loading) return <LoadingState label="正在加载 frps 实例…" />;
	if (resource.error)
		return <ErrorState message="无法加载 frps 实例" onRetry={resource.reload} />;

	return (
		<>
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>frps 实例</CardTitle>
						<Button
							size="sm"
							onClick={() => {
								setEditing(undefined);
								setActionError("");
								setDrawerOpen(true);
							}}
						>
							<Plus className="size-4" />新增实例
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					{actionError && !drawerOpen && !deleting && (
						<p role="alert" className="mb-4 text-sm text-red-400">
							{actionError}
						</p>
					)}
					{!resource.data?.data.length ? (
						<p className="text-sm text-muted-foreground">暂无实例</p>
					) : (
						<div className="divide-y divide-border/60">
							{resource.data.data.map((item) => (
								<article key={item.id} className="space-y-3 py-4">
									<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
										<div>
											<div className="flex items-center gap-2">
												<h3 className="font-medium">{item.name}</h3>
												{item.isDefault && <StatusChip label="默认" />}
												<ProbeStatus item={item} result={probes[item.id]} />
											</div>
											<p className="mt-1 text-sm text-muted-foreground">
												{item.serverAddr}:{item.serverPort}
											</p>
											<p className="text-sm text-muted-foreground">
												端口范围 {item.portRangeStart}–{item.portRangeEnd}
											</p>
										</div>
										<div className="flex flex-wrap gap-2">
											{!item.isDefault && (
												<Button size="sm" variant="outline" onClick={() => setDefault(item.id)}>
													设为默认
												</Button>
											)}
											<Button size="sm" variant="outline" disabled={probingId === item.id} onClick={() => probe(item.id)}>
												{probingId === item.id ? "检查中…" : "健康检查"}
											</Button>
											<Button size="sm" variant="outline" onClick={() => openEdit(item)}>编辑</Button>
											<Button size="sm" variant="destructive" onClick={() => { setActionError(""); setDeleting(item); }}>删除</Button>
										</div>
									</div>
									{probes[item.id] && <ProbeDetails result={probes[item.id]} />}
								</article>
							))}
						</div>
					)}
					{resource.data && resource.data.totalPages > 1 && (
						<div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
							<span>共 {resource.data.total} 条，第 {resource.data.page}/{resource.data.totalPages} 页</span>
							<div className="flex gap-2">
								<Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
								<Button size="sm" variant="outline" disabled={page >= resource.data.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</Button>
							</div>
						</div>
					)}
				</CardContent>
			</Card>
			<Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title={editing ? "编辑实例" : "新增实例"}>
				<InstanceForm key={editing?.id ?? "new"} initial={editing} onSubmit={save} saving={saving} error={drawerOpen ? actionError : ""} />
			</Drawer>
			{deleting && (
				<ConfirmTargetDialog
					open
					target={deleting.name}
					title="删除 frps 实例"
					error={actionError}
					onOpenChange={(open) => { if (!open) { setDeleting(undefined); setActionError(""); } }}
					onConfirm={remove}
				/>
			)}
		</>
	);
}

function InstanceForm({ initial, onSubmit, saving, error }: {
	initial?: FrpsInstanceInfo;
	onSubmit: (input: FrpsInstanceCreateRequest | FrpsInstanceUpdateRequest) => Promise<void>;
	saving: boolean;
	error: string;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [serverAddr, setServerAddr] = useState(initial?.serverAddr ?? "");
	const [serverPort, setServerPort] = useState(String(initial?.serverPort ?? 7000));
	const [authToken, setAuthToken] = useState(initial?.authToken ?? "");
	const [dashboardScheme, setDashboardScheme] = useState<"http" | "https">(initial?.dashboardScheme === "https" ? "https" : "http");
	const [dashboardHost, setDashboardHost] = useState(initial?.dashboardHost ?? "");
	const [dashboardPort, setDashboardPort] = useState(String(initial?.dashboardPort ?? 7500));
	const [dashboardUser, setDashboardUser] = useState(initial?.dashboardUser ?? "admin");
	const [dashboardPassword, setDashboardPassword] = useState(initial?.dashboardPassword ?? "");
	const [portRangeStart, setPortRangeStart] = useState(String(initial?.portRangeStart ?? 20000));
	const [portRangeEnd, setPortRangeEnd] = useState(String(initial?.portRangeEnd ?? 21000));
	const [isDefault, setIsDefault] = useState(false);
	const [showToken, setShowToken] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [rangeError, setRangeError] = useState("");

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (Number(portRangeStart) > Number(portRangeEnd)) {
			setRangeError("起始端口不能大于结束端口");
			return;
		}
		setRangeError("");
		const common = {
			name,
			serverAddr,
			serverPort: Number(serverPort),
			authToken,
			dashboardScheme,
			dashboardPort: Number(dashboardPort),
			dashboardUser,
			dashboardPassword,
			portRangeStart: Number(portRangeStart),
			portRangeEnd: Number(portRangeEnd),
		};
		await onSubmit(initial
			? { ...common, dashboardHost: dashboardHost || null }
			: { ...common, ...(dashboardHost ? { dashboardHost } : {}), isDefault });
	}

	return (
		<form className="space-y-4" onSubmit={submit}>
			<Field label="实例名称" id="instance-name" value={name} setValue={setName} required />
			<Field label="Server 地址" id="server-addr" value={serverAddr} setValue={setServerAddr} required />
			<Field label="Server 端口" id="server-port" value={serverPort} setValue={setServerPort} type="number" required />
			<SecretField label="Auth Token" id="auth-token" value={authToken} setValue={setAuthToken} visible={showToken} toggle={() => setShowToken((value) => !value)} />
			<div className="space-y-2">
				<Label htmlFor="dashboard-scheme">Dashboard Scheme</Label>
				<select id="dashboard-scheme" className="h-11 w-full rounded-lg border border-input bg-background/60 px-3" value={dashboardScheme} onChange={(event) => setDashboardScheme(event.target.value as "http" | "https")}>
					<option value="http">http</option><option value="https">https</option>
				</select>
			</div>
			<Field label="Dashboard Host" id="dashboard-host" value={dashboardHost} setValue={setDashboardHost} />
			<Field label="Dashboard 端口" id="dashboard-port" value={dashboardPort} setValue={setDashboardPort} type="number" required />
			<Field label="Dashboard 用户名" id="dashboard-user" value={dashboardUser} setValue={setDashboardUser} />
			<SecretField label="Dashboard 密码" id="dashboard-password" value={dashboardPassword} setValue={setDashboardPassword} visible={showPassword} toggle={() => setShowPassword((value) => !value)} />
			<Field label="端口范围起始" id="range-start" value={portRangeStart} setValue={setPortRangeStart} type="number" required />
			<Field label="端口范围结束" id="range-end" value={portRangeEnd} setValue={setPortRangeEnd} type="number" required />
			{rangeError && <p role="alert" className="text-sm text-red-400">{rangeError}</p>}
			{!initial && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />设为默认</label>}
			{error && <p role="alert" className="text-sm text-red-400">{error}</p>}
			<Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存实例"}</Button>
		</form>
	);
}

function Field({ label, id, value, setValue, type = "text", required = false }: {
	label: string; id: string; value: string; setValue: (value: string) => void; type?: string; required?: boolean;
}) {
	return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Input id={id} type={type} min={type === "number" ? 1 : undefined} max={type === "number" ? 65535 : undefined} value={value} onChange={(event) => setValue(event.target.value)} required={required} /></div>;
}

function SecretField({ label, id, value, setValue, visible, toggle }: {
	label: string; id: string; value: string; setValue: (value: string) => void; visible: boolean; toggle: () => void;
}) {
	return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><div className="flex gap-2"><Input id={id} type={visible ? "text" : "password"} value={value} onChange={(event) => setValue(event.target.value)} /><Button type="button" variant="outline" onClick={toggle}>{visible ? "隐藏" : "显示"}</Button></div></div>;
}

function ProbeStatus({ item, result }: { item: FrpsInstanceInfo; result?: ProbeResult }) {
	if (!result) return <StatusChip label="未检查" />;
	const label = !result.tcpReachable ? "TCP 不可达" : !item.dashboardHost ? "TCP 可达，未配置 Dashboard" : !result.dashboardReachable ? "Dashboard 不可达" : !result.authValid ? "Dashboard 认证无效" : "健康";
	return <StatusChip label={label} tone={result.ok ? "success" : "danger"} />;
}

function ProbeDetails({ result }: { result: ProbeResult }) {
	return (
		<div className="rounded-lg bg-secondary/40 p-3 text-sm">
			<p>
				TCP {result.tcpReachable ? "可达" : "不可达"} · {result.tcpLatencyMs} ms
			</p>
			<p>
				Dashboard {result.dashboardReachable ? "可达" : "不可达"} · 认证
				{result.authValid ? "有效" : "无效"}
			</p>
			{result.serverInfo && <p>FRP {result.serverInfo.version}</p>}
			{result.proxies && (
				<>
					<p>Proxy 共 {result.proxies.total} 个</p>
					<p>
						TCP {result.proxies.byType.tcp} · HTTP {result.proxies.byType.http} · HTTPS{" "}
						{result.proxies.byType.https}
					</p>
					<p>
						已占用端口：
						{result.proxies.usedPorts.join(", ") || "无"}
					</p>
				</>
			)}
		</div>
	);
}

function message(error: unknown, fallback: string) {
	return error instanceof Error ? error.message : fallback;
}
