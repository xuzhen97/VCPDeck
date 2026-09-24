import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
	PI_BUILTIN_TOOL_IDS,
	PI_TOOL_POLICY_BUCKETS,
	type PiCredentialInfo,
	type PiModelRef,
	type PiProfileInfo,
	type PiProviderInfo,
	type PiRuntimeStatus,
	type PiToolPolicy,
	type PiToolPolicyBucket,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { apiErrorMessage } from "@/api/error-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/status-chip";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "max"];

/** 执行 confirm 策略的 Bundle 资源 ID（与 Server 校验、ADR-0030 一致）。 */
const TOOL_POLICY_RESOURCE_ID = "vcp.tool-policy";

/** 新建 Profile 的基线策略：读类放行、写与执行类需审批，deny 留空。 */
const BASELINE_TOOL_POLICY: PiToolPolicy = {
	allow: ["read", "grep", "find", "ls"],
	confirm: ["write", "edit", "bash"],
	deny: [],
};

/** 每行一个 `provider/modelId`（可带 `@thinkingLevel`）。 */
function parseAllowedModels(text: string): PiModelRef[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [provider, modelId] = line.split("/");
			return { provider: provider ?? "", modelId: modelId ?? "" };
		});
}

const toLines = (models: PiModelRef[]): string =>
	models.map((model) => `${model.provider}/${model.modelId}`).join("\n");

/** Pi Profile 管理：模型策略的唯一权威在 Server。 */
export function PiProfilesPanel() {
	const sdk = useSdk();
	const [items, setItems] = useState<PiProfileInfo[]>([]);
	const [credentials, setCredentials] = useState<PiCredentialInfo[]>([]);
	const [providers, setProviders] = useState<PiProviderInfo[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [name, setName] = useState("");
	const [defaultProvider, setDefaultProvider] = useState("");
	const [defaultModelId, setDefaultModelId] = useState("");
	const [defaultThinkingLevel, setDefaultThinkingLevel] = useState("medium");
	const [allowedLines, setAllowedLines] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [selectedCredentialIds, setSelectedCredentialIds] = useState<string[]>([]);
	const [toolPolicy, setToolPolicy] = useState<PiToolPolicy>(BASELINE_TOOL_POLICY);
	const [enabledResourceIds, setEnabledResourceIds] = useState<string[]>([]);
	/** 已由 Client 上报的 Bundle 资源 ID 并集（空 = 尚无 Client 上报）。 */
	const [availableResourceIds, setAvailableResourceIds] = useState<string[]>([]);
		const selectedProviderIds = new Set(
			credentials
				.filter((credential) => selectedCredentialIds.includes(credential.id))
				.map((credential) => credential.providerConfigId),
		);
		const availableProviders = providers.filter((provider) => selectedProviderIds.has(provider.id));
		/** 已选凭据覆盖的 runtimeProviderId 集合：与 allowedModels.provider 同一 ID 空间（≠ 表行 id） */
		const selectedRuntimeProviders = new Set(
			credentials
				.filter((credential) => selectedCredentialIds.includes(credential.id))
				.map((credential) => credential.runtimeProviderId),
		);
	const selectedProvider = availableProviders.find((provider) => provider.runtimeProviderId === defaultProvider);
	const catalogModels = selectedProvider?.models ?? [];

	const load = useCallback(async () => {
		try {
			const [page, providerPage, credentialPage, clientList] =
				await Promise.all([
					sdk.pi.profiles.list(),
					sdk.pi.providers.list(),
					sdk.pi.credentials.list(),
					sdk.clients.list(),
				]);
			// Bundle 资源选项来自各 Client 上报的已校验资源（与模型目录上报同一形态）。
			const statusEntries = await Promise.all(
				clientList.map(async (client) => {
					try {
						return await sdk.pi.runtime(client.clientId);
					} catch {
						return null;
					}
				}),
			);
			const resourceIds = new Set<string>();
			for (const status of statusEntries as Array<PiRuntimeStatus | null>) {
				for (const id of status?.bundle?.resourceIds ?? []) resourceIds.add(id);
			}
			setAvailableResourceIds([...resourceIds].sort());
			setItems(page.data);
			setProviders(providerPage.data.filter((item) => item.configurationState === "ready"));
			setCredentials(credentialPage.data.filter((item) => !item.revokedAt));
		} catch {
			setError("无法读取 Pi Profile 列表");
		} finally {
			setLoaded(true);
		}
	}, [sdk]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (!availableProviders.some((provider) => provider.runtimeProviderId === defaultProvider)) {
			setDefaultProvider(availableProviders[0]?.runtimeProviderId ?? "");
		}
	}, [availableProviders, defaultProvider]);

	/** 勾选某个桶即从其它桶移除：三桶互斥（与 Server 校验一致）。 */
	function toggleTool(bucket: PiToolPolicyBucket, tool: string) {
		setToolPolicy((prev) => {
			const next: PiToolPolicy = {
				allow: [...prev.allow],
				confirm: [...prev.confirm],
				deny: [...prev.deny],
			};
			const enabled = next[bucket].includes(tool);
			for (const other of PI_TOOL_POLICY_BUCKETS) {
				next[other] = next[other].filter((item) => item !== tool);
			}
			if (!enabled) next[bucket].push(tool);
			return next;
		});
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (saving) return;
		// 前端只做与 Server 同构的快速校验；不再静默过滤未配置的模型行 ——
		// 那样会让用户填的内容无声消失，改由 Server 返回精确原因并原样展示。
		const allowed = parseAllowedModels(allowedLines);
		if (allowed.length === 0) {
			setError("请填写至少一行允许模型（provider/modelId）");
			return;
		}
		if (
			!allowed.some(
				(model) =>
					model.provider === defaultProvider && model.modelId === defaultModelId,
			)
		) {
			setError("默认模型必须位于允许模型列表");
			return;
		}
		const allowedProviders = [
			...new Set(allowed.map((model) => model.provider)),
		];
		const missingProviders = allowedProviders.filter(
			(providerId) => !selectedRuntimeProviders.has(providerId),
		);
		if (missingProviders.length > 0) {
			setError(`Provider ${missingProviders.join("、")} 缺少关联凭据`);
			return;
		}
		const extraProviders = [...selectedRuntimeProviders].filter(
			(providerId) => !allowedProviders.includes(providerId),
		);
		if (extraProviders.length > 0) {
			setError(
				`已选凭据包含不在允许模型中的 Provider：${extraProviders.join("、")}`,
			);
			return;
		}
		// confirm 由随 Bundle 发布的策略扩展执行；未启用该资源则策略永远无法生效。
		if (
			toolPolicy.confirm.length > 0 &&
			!enabledResourceIds.includes(TOOL_POLICY_RESOURCE_ID)
		) {
			setError(`启用 confirm 必须先启用 ${TOOL_POLICY_RESOURCE_ID} 资源`);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const input = {
				name: name.trim(),
				defaultModel: {
					provider: defaultProvider.trim(),
					modelId: defaultModelId.trim(),
				},
				allowedModels: allowed,
				defaultThinkingLevel,
				credentialIds: selectedCredentialIds,
				toolPolicy,
				enabledResourceIds,
			};
			const saved = editingId
				? await sdk.pi.profiles.update(editingId, input)
				: await sdk.pi.profiles.create(input);
			setItems((prev) => editingId ? prev.map((item) => item.id === editingId ? saved : item) : [saved, ...prev]);
			setEditingId(null);
			setName("");
			setDefaultProvider("");
			setDefaultModelId("");
			setDefaultThinkingLevel("medium");
			setAllowedLines("");
			setSelectedCredentialIds([]);
			setToolPolicy(BASELINE_TOOL_POLICY);
			setEnabledResourceIds([]);
		} catch (error) {
			setError(apiErrorMessage(error, "Profile 保存失败，请检查模型与 thinking 级别"));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Pi · Profile</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="text-xs text-muted-foreground">
					模型、thinking 与允许范围由 Server 持久化；修改会递增 revision 并触发运行时换代。
				</p>
				<form onSubmit={submit} className="space-y-3">
					<div className="grid gap-3 md:grid-cols-4">
						<div className="space-y-1.5">
							<Label htmlFor="pi-profile-name">名称</Label>
							<Input
								id="pi-profile-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="pi-profile-provider">默认 Provider</Label>
							<select
								id="pi-profile-provider"
								value={defaultProvider}
								onChange={(e) => setDefaultProvider(e.target.value)}
								required
								disabled={availableProviders.length === 0}
								className="w-full rounded-md border border-border bg-background p-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
							>
								<option value="" disabled>
									{availableProviders.length === 0
										? "请先关联凭据"
										: "选择 Provider"}
								</option>
								{availableProviders.map((provider) => (
									<option key={provider.id} value={provider.runtimeProviderId}>
										{provider.name} ({provider.runtimeProviderId})
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="pi-profile-model">默认模型 ID</Label>
							<Input
								id="pi-profile-model"
								list="pi-profile-model-options"
								value={defaultModelId}
								onChange={(e) => setDefaultModelId(e.target.value)}
								required
							/>
							<datalist id="pi-profile-model-options">
								{catalogModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
							</datalist>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="pi-profile-thinking">默认 thinking</Label>
							<select
								id="pi-profile-thinking"
								data-testid="pi-profile-thinking"
								value={defaultThinkingLevel}
								onChange={(e) => setDefaultThinkingLevel(e.target.value)}
								className="w-full rounded-md border border-border bg-background p-2 text-sm"
							>
								{THINKING_LEVELS.map((level) => (
									<option key={level} value={level}>
										{level}
									</option>
								))}
							</select>
						</div>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="pi-profile-models">允许模型（每行一个 provider/modelId）</Label>
						<textarea
							id="pi-profile-models"
							data-testid="pi-profile-models"
							value={allowedLines}
							onChange={(e) => setAllowedLines(e.target.value)}
							rows={3}
							placeholder={`${defaultProvider || "provider"}/${defaultModelId || "model-id"}`}
							className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
						/>
					</div>
					<div className="space-y-1.5" data-testid="pi-profile-credentials">
						<Label>凭据（可多选，每个允许 Provider 至少一个）</Label>
						<div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
							{credentials.length === 0 && (
								<p className="text-muted-foreground">
									尚无可用凭据，请先在 Provider 页接入
								</p>
							)}
							{credentials.map((credential) => (
								<label key={credential.id} className="flex items-center gap-2">
									<input
										type="checkbox"
										checked={selectedCredentialIds.includes(credential.id)}
										onChange={() =>
											setSelectedCredentialIds((prev) =>
												prev.includes(credential.id)
													? prev.filter((id) => id !== credential.id)
													: [...prev, credential.id],
											)
										}
									/>
									<span>
										{credential.name} ({credential.runtimeProviderId})
									</span>
								</label>
							))}
						</div>
					</div>
					<div className="space-y-1.5" data-testid="pi-profile-tool-policy">
						<Label>工具策略（未列出的工具默认拒绝）</Label>
						<div className="space-y-2 rounded-md border border-border p-3 text-sm">
							{PI_TOOL_POLICY_BUCKETS.map((bucket) => (
								<div
									key={bucket}
									className="flex flex-wrap items-center gap-3"
								>
									<span className="w-16 text-muted-foreground">{bucket}</span>
									{PI_BUILTIN_TOOL_IDS.map((tool) => (
										<label
											key={`${bucket}-${tool}`}
											className="flex items-center gap-1"
										>
											<input
												type="checkbox"
												aria-label={`策略-${bucket}-${tool}`}
												checked={toolPolicy[bucket].includes(tool)}
												onChange={() => toggleTool(bucket, tool)}
											/>
											<span>
												{tool}
												{tool === "powershell" ? "（仅 Windows）" : ""}
											</span>
										</label>
									))}
								</div>
							))}
						</div>
					</div>
					<div className="space-y-1.5" data-testid="pi-profile-resources">
						<Label>启用 Bundle 资源</Label>
						<div className="space-y-1 rounded-md border border-border p-3 text-sm">
							{availableResourceIds.length === 0 && (
								<p className="text-muted-foreground">
									尚无 Client 上报 Bundle 资源；启用后下发时会对缺失资源 fail closed。
								</p>
							)}
							{availableResourceIds.map((id) => (
								<label key={id} className="flex items-center gap-1">
									<input
										type="checkbox"
										aria-label={`资源-${id}`}
										checked={enabledResourceIds.includes(id)}
										onChange={() =>
											setEnabledResourceIds((prev) =>
												prev.includes(id)
													? prev.filter((item) => item !== id)
													: [...prev, id],
											)
										}
									/>
									<span>{id}</span>
								</label>
							))}
						</div>
					</div>
					<div className="flex items-end gap-2">
						<Button type="submit" disabled={saving || availableProviders.length === 0}>
							{saving ? "保存中…" : editingId ? "更新 Profile" : "创建 Profile"}
						</Button>
						{editingId && <Button type="button" variant="outline" onClick={() => {
							setEditingId(null); setName(""); setDefaultProvider(""); setDefaultModelId(""); setAllowedLines(""); setSelectedCredentialIds([]);
						}}>取消</Button>}
					</div>
				</form>

				{error && (
					<p data-testid="pi-profiles-error" className="text-sm text-destructive">
						{error}
					</p>
				)}

				<div className="space-y-2">
					{loaded && items.length === 0 && (
						<p className="text-sm text-muted-foreground">尚未配置 Profile</p>
					)}
					{items.map((item) => (
						<div
							key={item.id}
							className="space-y-2 rounded-md border border-border/70 p-3 text-sm"
						>
							<div className="flex flex-wrap items-center gap-3">
								<Button type="button" variant="outline" onClick={() => {
									setEditingId(item.id);
									setName(item.name);
									setDefaultProvider(item.defaultModel.provider);
									setDefaultModelId(item.defaultModel.modelId);
									setDefaultThinkingLevel(item.defaultThinkingLevel);
									setAllowedLines(toLines(item.allowedModels));
									setSelectedCredentialIds(item.credentialIds);
									setToolPolicy(item.toolPolicy);
									setEnabledResourceIds(item.enabledResourceIds);
								}}>编辑</Button>
								<StatusChip
									label={item.enabled ? "启用" : "停用"}
									tone={item.enabled ? "success" : "danger"}
								/>
								<span className="font-medium">{item.name}</span>
								<span className="text-muted-foreground">
									{item.defaultModel.provider}/{item.defaultModel.modelId}
								</span>
								<span className="text-xs text-muted-foreground">
									thinking {item.defaultThinkingLevel}
								</span>
								<span className="text-xs text-muted-foreground">
									revision {item.revision}
								</span>
								<span className="text-xs text-muted-foreground">
									凭据 {item.credentialIds.length} · 绑定 Client {item.boundClientIds.length}
								</span>
							</div>
							<pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
								{toLines(item.allowedModels)}
							</pre>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
