import type {
	FrpsInstanceCreateRequest,
	FrpsInstanceInfo,
	FrpsInstanceUpdateRequest,
	ProbeResult,
} from "@vcpdeck/shared";
import { Plus } from "lucide-react";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";
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
import { FrpActionMenu } from "./frp-action-menu";

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
		return (
			<ErrorState message="无法加载 frps 实例" onRetry={resource.reload} />
		);

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
							<Plus className="size-4" />
							新增实例
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
						<div className="overflow-visible rounded-2xl border border-border/70 bg-background/40">
							<div className="hidden grid-cols-[1.15fr_1.05fr_.95fr_.8fr_1fr_3rem] gap-3 border-b border-border/60 bg-secondary/40 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
								<span>实例</span>
								<span>Server</span>
								<span>端口池</span>
								<span>Dashboard</span>
								<span>健康状态</span>
								<span />
							</div>
							<div className="divide-y divide-border/60">
								{resource.data.data.map((item) => (
									<article key={item.id} className="px-4 py-4">
										<div className="hidden items-center gap-3 md:grid md:grid-cols-[1.15fr_1.05fr_.95fr_.8fr_1fr_3rem]">
											<div>
												<div className="flex items-center gap-2">
													<h3 className="font-medium">{item.name}</h3>
													{item.isDefault && <StatusChip label="默认" />}
												</div>
												<p className="mt-1 font-mono text-xs text-muted-foreground">
													{shortId(item.id)}
												</p>
											</div>
											<code className="text-sm">
												{item.serverAddr}:{item.serverPort}
											</code>
											<div>
												<code className="text-sm">
													{item.portRangeStart}–{item.portRangeEnd}
												</code>
												<p className="mt-1 text-xs text-muted-foreground">
													{portCount(item).toLocaleString("zh-CN")} 个端口
												</p>
											</div>
											<StatusChip label={dashboardLabel(item)} />
											<div>
												<ProbeStatus item={item} result={probes[item.id]} />
												{probes[item.id]?.serverInfo && (
													<p className="mt-1 text-xs text-muted-foreground">
														FRP {probes[item.id]?.serverInfo?.version}
													</p>
												)}
											</div>
											<FrpActionMenu
												items={[
													{
														label:
															probingId === item.id ? "检查中…" : "健康检查",
														disabled: probingId === item.id,
														onSelect: () => probe(item.id),
													},
													{ label: "编辑配置", onSelect: () => openEdit(item) },
													...(item.isDefault
														? []
														: [
																{
																	label: "设为默认",
																	onSelect: () => setDefault(item.id),
																},
															]),
													{
														label: "删除实例",
														tone: "danger" as const,
														onSelect: () => {
															setActionError("");
															setDeleting(item);
														},
													},
												]}
											/>
										</div>
										<div className="space-y-3 md:hidden">
											<div className="flex items-start justify-between gap-3">
												<div>
													<div className="flex items-center gap-2">
														<h3 className="font-medium">{item.name}</h3>
														{item.isDefault && <StatusChip label="默认" />}
														<ProbeStatus item={item} result={probes[item.id]} />
													</div>
													<p className="mt-1 text-sm text-muted-foreground">
														{item.serverAddr}:{item.serverPort}
													</p>
													<p className="font-mono text-xs text-muted-foreground">
														{shortId(item.id)}
													</p>
												</div>
												<FrpActionMenu
													items={[
														{
															label:
																probingId === item.id ? "检查中…" : "健康检查",
															disabled: probingId === item.id,
															onSelect: () => probe(item.id),
														},
														{
															label: "编辑配置",
															onSelect: () => openEdit(item),
														},
														...(item.isDefault
															? []
															: [
																	{
																		label: "设为默认",
																		onSelect: () => setDefault(item.id),
																	},
																]),
														{
															label: "删除实例",
															tone: "danger" as const,
															onSelect: () => {
																setActionError("");
																setDeleting(item);
															},
														},
													]}
												/>
											</div>
											<div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
												<code>
													{item.portRangeStart}–{item.portRangeEnd}
												</code>
												<span>
													{portCount(item).toLocaleString("zh-CN")} 个端口
												</span>
												<span>{dashboardLabel(item)}</span>
											</div>
										</div>
										{probes[item.id] && (
											<ProbeDetails result={probes[item.id]} />
										)}
									</article>
								))}
							</div>
						</div>
					)}
					{resource.data && resource.data.totalPages > 1 && (
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
									onClick={() => setPage((value) => value - 1)}
								>
									上一页
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={page >= resource.data.totalPages}
									onClick={() => setPage((value) => value + 1)}
								>
									下一页
								</Button>
							</div>
						</div>
					)}
				</CardContent>
			</Card>
			<Drawer
				open={drawerOpen}
				onClose={() => setDrawerOpen(false)}
				title={editing ? "编辑实例" : "新增实例"}
				size="wide"
			>
				<InstanceForm
					key={editing?.id ?? "new"}
					initial={editing}
					onSubmit={save}
					saving={saving}
					error={drawerOpen ? actionError : ""}
				/>
			</Drawer>
			{deleting && (
				<ConfirmTargetDialog
					open
					target={deleting.name}
					title="删除 frps 实例"
					error={actionError}
					onOpenChange={(open) => {
						if (!open) {
							setDeleting(undefined);
							setActionError("");
						}
					}}
					onConfirm={remove}
				/>
			)}
		</>
	);
}

function InstanceForm({
	initial,
	onSubmit,
	saving,
	error,
}: {
	initial?: FrpsInstanceInfo;
	onSubmit: (
		input: FrpsInstanceCreateRequest | FrpsInstanceUpdateRequest,
	) => Promise<void>;
	saving: boolean;
	error: string;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [serverAddr, setServerAddr] = useState(initial?.serverAddr ?? "");
	const [serverPort, setServerPort] = useState(
		String(initial?.serverPort ?? 7000),
	);
	const [authToken, setAuthToken] = useState(initial?.authToken ?? "");
	const [dashboardScheme, setDashboardScheme] = useState<"http" | "https">(
		initial?.dashboardScheme === "https" ? "https" : "http",
	);
	const [dashboardHost, setDashboardHost] = useState(
		initial?.dashboardHost ?? "",
	);
	const [dashboardPort, setDashboardPort] = useState(
		String(initial?.dashboardPort ?? 7500),
	);
	const [dashboardUser, setDashboardUser] = useState(
		initial?.dashboardUser ?? "admin",
	);
	const [dashboardPassword, setDashboardPassword] = useState(
		initial?.dashboardPassword ?? "",
	);
	const [portRangeStart, setPortRangeStart] = useState(
		String(initial?.portRangeStart ?? 20000),
	);
	const [portRangeEnd, setPortRangeEnd] = useState(
		String(initial?.portRangeEnd ?? 21000),
	);
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
		await onSubmit(
			initial
				? { ...common, dashboardHost: dashboardHost || null }
				: { ...common, ...(dashboardHost ? { dashboardHost } : {}), isDefault },
		);
	}

	return (
		<form className="space-y-4" onSubmit={submit}>
			<FormSection title="基础连接">
				<Field
					label="实例名称"
					id="instance-name"
					value={name}
					setValue={setName}
					required
				/>
				<Field
					label="Server 地址"
					id="server-addr"
					value={serverAddr}
					setValue={setServerAddr}
					required
				/>
				<Field
					label="Server 端口"
					id="server-port"
					value={serverPort}
					setValue={setServerPort}
					type="number"
					required
				/>
				<SecretField
					label="Auth Token"
					id="auth-token"
					value={authToken}
					setValue={setAuthToken}
					visible={showToken}
					toggle={() => setShowToken((value) => !value)}
				/>
			</FormSection>
			<FormSection title="Dashboard">
				<div className="space-y-2">
					<Label htmlFor="dashboard-scheme">Dashboard Scheme</Label>
					<select
						id="dashboard-scheme"
						className="h-11 w-full rounded-lg border border-input bg-background/60 px-3"
						value={dashboardScheme}
						onChange={(event) =>
							setDashboardScheme(event.target.value as "http" | "https")
						}
					>
						<option value="http">http</option>
						<option value="https">https</option>
					</select>
				</div>
				<Field
					label="Dashboard Host"
					id="dashboard-host"
					value={dashboardHost}
					setValue={setDashboardHost}
				/>
				<Field
					label="Dashboard 端口"
					id="dashboard-port"
					value={dashboardPort}
					setValue={setDashboardPort}
					type="number"
					required
				/>
				<Field
					label="Dashboard 用户名"
					id="dashboard-user"
					value={dashboardUser}
					setValue={setDashboardUser}
				/>
				<SecretField
					label="Dashboard 密码"
					id="dashboard-password"
					value={dashboardPassword}
					setValue={setDashboardPassword}
					visible={showPassword}
					toggle={() => setShowPassword((value) => !value)}
				/>
			</FormSection>
			<FormSection title="端口范围">
				<Field
					label="端口范围起始"
					id="range-start"
					value={portRangeStart}
					setValue={setPortRangeStart}
					type="number"
					required
				/>
				<Field
					label="端口范围结束"
					id="range-end"
					value={portRangeEnd}
					setValue={setPortRangeEnd}
					type="number"
					required
				/>
			</FormSection>
			{rangeError && (
				<p role="alert" className="text-sm text-red-400">
					{rangeError}
				</p>
			)}
			{!initial && (
				<FormSection title="默认设置">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={isDefault}
							onChange={(event) => setIsDefault(event.target.checked)}
						/>
						设为默认
					</label>
				</FormSection>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-400">
					{error}
				</p>
			)}
			<Button type="submit" disabled={saving}>
				{saving ? "保存中…" : "保存实例"}
			</Button>
		</form>
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

function Field({
	label,
	id,
	value,
	setValue,
	type = "text",
	required = false,
}: {
	label: string;
	id: string;
	value: string;
	setValue: (value: string) => void;
	type?: string;
	required?: boolean;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				type={type}
				min={type === "number" ? 1 : undefined}
				max={type === "number" ? 65535 : undefined}
				value={value}
				onChange={(event) => setValue(event.target.value)}
				required={required}
			/>
		</div>
	);
}

function SecretField({
	label,
	id,
	value,
	setValue,
	visible,
	toggle,
}: {
	label: string;
	id: string;
	value: string;
	setValue: (value: string) => void;
	visible: boolean;
	toggle: () => void;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<div className="flex gap-2">
				<Input
					id={id}
					type={visible ? "text" : "password"}
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
				<Button type="button" variant="outline" onClick={toggle}>
					{visible ? "隐藏" : "显示"}
				</Button>
			</div>
		</div>
	);
}

function ProbeStatus({
	item,
	result,
}: {
	item: FrpsInstanceInfo;
	result?: ProbeResult;
}) {
	if (!result) return <StatusChip label="未检查" />;
	const label = !result.tcpReachable
		? "TCP 不可达"
		: !item.dashboardHost
			? "TCP 可达，未配置 Dashboard"
			: !result.dashboardReachable
				? "Dashboard 不可达"
				: !result.authValid
					? "Dashboard 认证无效"
					: "健康";
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
						TCP {result.proxies.byType.tcp} · HTTP {result.proxies.byType.http}{" "}
						· HTTPS {result.proxies.byType.https}
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

function shortId(value: string) {
	return `${value.slice(0, 8)}…`;
}

function portCount(item: FrpsInstanceInfo) {
	return item.portRangeEnd - item.portRangeStart + 1;
}

function dashboardLabel(item: FrpsInstanceInfo) {
	return item.dashboardHost ? item.dashboardScheme.toUpperCase() : "未配置";
}

function message(error: unknown, fallback: string) {
	return error instanceof Error ? error.message : fallback;
}
