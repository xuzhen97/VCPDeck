import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
	PiCredentialInfo,
	PiModelMetadataSource,
	PiProviderCreateInput,
	PiProviderInfo,
	PiProviderModel,
	PiProviderModelInfo,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { apiErrorMessage } from "@/api/error-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/status-chip";

const protocols = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

/** 自定义元数据的未确认占位值：UI 必须标注未确认，不能表现为已核实事实。 */
const placeholderMetadata: Omit<PiProviderModelInfo, "id" | "name"> = {
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: {},
};

/** 由名称派生 Runtime Provider ID（Pi 侧的 provider 标识，用户无需发明）。 */
function deriveRuntimeProviderId(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function explicitModel(model: PiProviderModel): PiProviderModelInfo {
	return model.metadataSource === "explicit"
		? model.metadata
		: { id: model.id, name: model.name, ...placeholderMetadata };
}

/**
 * Pi Provider 接入与凭据管理。
 *
 * 一次接入只填 名称/协议/Base URL/API Key；「拉取模型」列出远程端点的模型，
 * 只有勾选的模型才进入 Provider 目录（元数据编辑器按需展开，不平铺）。
 * 凭据在保存时于同一事务内创建。API Key 明文只存在于提交窗口，提交后立即清空。
 */
export function PiProvidersPanel() {
	const sdk = useSdk();
	const [providers, setProviders] = useState<PiProviderInfo[]>([]);
	const [credentials, setCredentials] = useState<PiCredentialInfo[]>([]);
	const [models, setModels] = useState<PiProviderModel[]>([]);
	/** 可选模型全集（拉取结果 ∪ 当前已配置）；勾选 = 进入 models。 */
	const [candidates, setCandidates] = useState<Array<{ id: string; name: string }>>([]);
	/** 新勾选模型默认采用的元数据来源（来自发现结果的建议）。 */
	const [recommendedSource, setRecommendedSource] =
		useState<PiModelMetadataSource>("catalog");
	/** 展开元数据编辑器的模型 ID：默认全部收起，避免上百个输入框平铺。 */
	const [expandedIds, setExpandedIds] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [discovering, setDiscovering] = useState(false);
	const [name, setName] = useState("");
	const [runtimeProviderId, setRuntimeProviderId] = useState("");
	const [runtimeProviderIdEdited, setRuntimeProviderIdEdited] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [protocol, setProtocol] =
		useState<(typeof protocols)[number]>("openai-responses");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [providerPage, credentialPage] = await Promise.all([
				sdk.pi.providers.list(),
				sdk.pi.credentials.list(),
			]);
			setProviders(providerPage.data);
			setCredentials(credentialPage.data);
		} catch {
			setError("无法读取 Pi Provider 配置");
		} finally {
			setLoaded(true);
		}
	}, [sdk]);

	useEffect(() => {
		void load();
	}, [load]);

	function resetForm() {
		setEditingId(null);
		setName("");
		setRuntimeProviderId("");
		setRuntimeProviderIdEdited(false);
		setShowAdvanced(false);
		setProtocol("openai-responses");
		setBaseUrl("");
		setModels([]);
		setCandidates([]);
		setExpandedIds([]);
		setQuery("");
		setRecommendedSource("catalog");
	}

	function startEdit(item: PiProviderInfo) {
		setEditingId(item.id);
		setName(item.name);
		setRuntimeProviderId(item.runtimeProviderId);
		setRuntimeProviderIdEdited(true);
		setShowAdvanced(true);
		setProtocol(item.protocol ?? "openai-responses");
		setBaseUrl(item.baseUrl ?? "");
		setModels(item.models.map((model) => ({ ...model })));
		setCandidates(
			item.models.map((model) => ({ id: model.id, name: model.name })),
		);
		setRecommendedSource(
			item.models.length > 0 &&
				item.models.every((model) => model.metadataSource === "catalog")
				? "catalog"
				: "explicit",
		);
		setExpandedIds([]);
		setQuery("");
		setApiKey("");
		setError(null);
		setNotice(null);
	}

	async function pullModels() {
		if (discovering) return;
		setDiscovering(true);
		setError(null);
		setNotice(null);
		try {
			// 编辑已保存 Provider 时复用其已存凭据；新接入时用当前输入的目标与 Key。
			const result = editingId && !apiKey
				? await sdk.pi.providers.discoverModels(editingId)
				: await sdk.pi.providers.discover({
						protocol,
						baseUrl: baseUrl.trim(),
						apiKey,
						...(runtimeProviderId.trim()
							? { runtimeProviderId: runtimeProviderId.trim() }
							: {}),
					});
			const source: PiModelMetadataSource = result.recommendedMetadataSource;
			// 候选集 = 拉取结果 ∪ 当前已配置：重新拉取不会静默丢掉已勾选的模型。
			const pulledIds = new Set(result.models.map((model) => model.id));
			setCandidates([
				...result.models.map((model) => ({ id: model.id, name: model.name })),
				...models
					.filter((model) => !pulledIds.has(model.id))
					.map((model) => ({ id: model.id, name: model.name })),
			]);
			setRecommendedSource(source);
			setExpandedIds([]);
			setNotice(
				source === "catalog"
					? `已拉取 ${result.models.length} 个模型，元数据由 Pi 内置目录（${result.catalogSdkVersion ?? "未知版本"}）提供`
					: `已拉取 ${result.models.length} 个模型；未命中内置目录，按未确认的显式元数据接入`,
			);
		} catch (error) {
			setError(
				apiErrorMessage(error, "模型发现失败，请检查协议、端点与 API Key"),
			);
		} finally {
			setDiscovering(false);
		}
	}

	function setModelSource(id: string, source: PiModelMetadataSource) {
		setModels((items) =>
			items.map((model) =>
				model.id !== id
					? model
					: source === "catalog"
						? { id: model.id, name: model.name, metadataSource: "catalog" }
						: {
								id: model.id,
								name: model.name,
								metadataSource: "explicit",
								metadata: explicitModel(model),
							},
			),
		);
	}

	function patchModelMetadata(id: string, patch: Partial<PiProviderModelInfo>) {
		setModels((items) =>
			items.map((model) =>
				model.id === id && model.metadataSource === "explicit"
					? { ...model, metadata: { ...model.metadata, ...patch } }
					: model,
			),
		);
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (saving) return;
		const effectiveRuntimeProviderId =
			runtimeProviderId.trim() || deriveRuntimeProviderId(name);
		if (!effectiveRuntimeProviderId) {
			setError("无法从名称派生 Runtime Provider ID，请展开高级手动填写");
			return;
		}
		if (!editingId && !apiKey) {
			setError("首次接入必须填写 API Key");
			return;
		}
		if (models.length === 0) {
			setError(
				candidates.length > 0 ? "请先勾选需要使用的模型" : "请先拉取并勾选模型",
			);
			return;
		}
		if (
			models.some((model) => model.metadataSource === "explicit") &&
			!baseUrl.trim()
		) {
			setError("显式元数据模型必须填写 Base URL");
			return;
		}
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const input: PiProviderCreateInput = {
				name: name.trim(),
				runtimeProviderId: effectiveRuntimeProviderId,
				protocol,
				baseUrl: baseUrl.trim() || null,
				headers: {},
				models,
				// 凭据与 Provider 在同一事务内创建；更新时不接受 credential。
				...(editingId || !apiKey ? {} : { credential: { apiKey } }),
			};
			const saved = editingId
				? await sdk.pi.providers.update(editingId, input)
				: await sdk.pi.providers.create(input);
			setProviders((items) =>
				editingId
					? items.map((item) => (item.id === editingId ? saved : item))
					: [saved, ...items],
			);
			if (!editingId) {
				const credentialPage = await sdk.pi.credentials.list();
				setCredentials(credentialPage.data);
			}
			// 保存成功才清空明文；失败时保留，否则刚写好的错误提示会把用户刚填的 Key 抹掉。
			setApiKey("");
			resetForm();
			setNotice("Provider 已保存");
		} catch (error) {
			setError(
				apiErrorMessage(error, "Provider 保存失败，请检查协议、端点与 API Key"),
			);
		} finally {
			setSaving(false);
		}
	}

	async function validateProvider(id: string) {
		setError(null);
		setNotice(null);
		try {
			await sdk.pi.providers.validate(id);
			setNotice("Provider 验证通过");
		} catch (error) {
			setError(apiErrorMessage(error, "Provider 验证失败，请检查端点与凭据"));
		}
	}

	async function revokeCredential(id: string) {
		setError(null);
		try {
			const revoked = await sdk.pi.credentials.revoke(id);
			setCredentials((items) =>
				items.map((item) => (item.id === id ? revoked : item)),
			);
		} catch (error) {
			setError(apiErrorMessage(error, "撤销失败，请稍后重试"));
		}
	}

	/** 勾选 = 纳入 Provider 目录；取消勾选 = 从提交中移除并收起其元数据编辑器。 */
	function toggleModel(
		candidate: { id: string; name: string },
		checked: boolean,
	) {
		if (!checked) {
			setExpandedIds((ids) => ids.filter((id) => id !== candidate.id));
			setModels((items) => items.filter((item) => item.id !== candidate.id));
			return;
		}
		setModels((items) =>
			items.some((item) => item.id === candidate.id)
				? items
				: [
						...items,
						recommendedSource === "catalog"
							? {
									id: candidate.id,
									name: candidate.name,
									metadataSource: "catalog",
								}
							: {
									id: candidate.id,
									name: candidate.name,
									metadataSource: "explicit",
									metadata: {
										...placeholderMetadata,
										id: candidate.id,
										name: candidate.name,
									},
								},
					],
		);
	}

	function toggleExpand(id: string) {
		setExpandedIds((ids) =>
			ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
		);
	}

	/** 按搜索词过滤的可选模型（搜索只过滤展示，不改变勾选状态）。 */
	const trimmedQuery = query.trim().toLowerCase();
	const visibleCandidates = trimmedQuery
		? candidates.filter(
				(candidate) =>
					candidate.id.toLowerCase().includes(trimmedQuery) ||
					candidate.name.toLowerCase().includes(trimmedQuery),
			)
		: candidates;

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>Pi · Provider</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-xs text-muted-foreground">
						Provider、协议与模型目录由 Server 权威管理；认证 Header 不在配置表单中填写。
						模型元数据优先取自 Pi 内置目录，只有自定义端点才使用显式元数据。
					</p>
					<form onSubmit={submit} className="space-y-3">
						<div className="grid gap-3 md:grid-cols-4">
							<div className="space-y-1.5">
								<Label htmlFor="pi-provider-name">名称</Label>
								<Input
									id="pi-provider-name"
									value={name}
									onChange={(e) => {
										setName(e.target.value);
										if (!runtimeProviderIdEdited) {
											setRuntimeProviderId(deriveRuntimeProviderId(e.target.value));
										}
									}}
									required
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="pi-provider-protocol">协议</Label>
								<select
									id="pi-provider-protocol"
									value={protocol}
									onChange={(e) =>
										setProtocol(e.target.value as (typeof protocols)[number])
									}
									className="w-full rounded-md border border-border bg-background p-2 text-sm"
								>
									{protocols.map((item) => (
										<option key={item}>{item}</option>
									))}
								</select>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="pi-provider-base-url">Base URL</Label>
								<Input
									id="pi-provider-base-url"
									value={baseUrl}
									onChange={(e) => setBaseUrl(e.target.value)}
									placeholder="https://llm.example/v1"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="pi-provider-api-key">API Key</Label>
								<Input
									id="pi-provider-api-key"
									aria-label="API Key"
									type="password"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder={editingId ? "留空则沿用已存凭据" : undefined}
								/>
							</div>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => void pullModels()}
								disabled={discovering || (!editingId && (!baseUrl.trim() || !apiKey))}
							>
								{discovering ? "拉取中…" : "拉取模型"}
							</Button>
							<Button type="button" variant="ghost" onClick={() => setShowAdvanced((v) => !v)}>
								{showAdvanced ? "收起高级" : "高级"}
							</Button>
							<Button
								type="submit"
								disabled={saving || models.length === 0}
							>
								{saving ? "保存中…" : editingId ? "更新 Provider" : "保存 Provider"}
							</Button>
							{editingId && (
								<Button type="button" variant="outline" onClick={resetForm}>
									取消
								</Button>
							)}
						</div>
						{showAdvanced && (
							<div className="space-y-1.5">
								<Label htmlFor="pi-runtime-provider-id">Runtime Provider ID</Label>
								<Input
									id="pi-runtime-provider-id"
									value={runtimeProviderId}
									onChange={(e) => {
										setRuntimeProviderId(e.target.value);
										setRuntimeProviderIdEdited(true);
									}}
									placeholder="默认由名称派生"
								/>
								<p className="text-xs text-muted-foreground">
									多选为 Pi 内置 Provider ID（如 anthropic、openai）时，模型元数据可直接来自内置目录。
								</p>
							</div>
						)}
					</form>

					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-3">
							<p className="text-xs text-muted-foreground">
								模型选择：已选 {models.length} / 共 {candidates.length}
								{candidates.length > 0 && models.length === 0
									? " · 勾选需要使用的模型后再保存"
									: ""}
							</p>
							<Input
								aria-label="搜索模型"
								placeholder="搜索模型 ID 或名称"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								className="ml-auto h-9 w-56"
							/>
						</div>
						{candidates.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								点击「拉取模型」列出远程端点的模型，再勾选需要使用的模型。
							</p>
						) : (
							<div className="max-h-80 overflow-y-auto rounded-md border border-border/70">
								{visibleCandidates.length === 0 && (
									<p className="px-3 py-2 text-sm text-muted-foreground">
										没有匹配的模型
									</p>
								)}
								{visibleCandidates.map((candidate) => {
									const selected = models.some(
										(item) => item.id === candidate.id,
									);
									const model = models.find(
										(item) => item.id === candidate.id,
									);
									return (
										<div
											key={candidate.id}
											className="border-b border-border/50 last:border-b-0"
										>
											<div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
												<input
													type="checkbox"
													id={`pi-model-${candidate.id}`}
													aria-label={candidate.id}
													checked={selected}
													onChange={(e) => toggleModel(candidate, e.target.checked)}
													className="h-4 w-4"
												/>
												<label
													htmlFor={`pi-model-${candidate.id}`}
													className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 ${selected ? "" : "opacity-60"}`}
												>
													<code className="truncate">{candidate.id}</code>
													{candidate.name !== candidate.id && (
														<span className="truncate text-muted-foreground">
															{candidate.name}
														</span>
													)}
												</label>
												{selected && model && (
													<>
														<select
															aria-label={`${candidate.id} 元数据来源`}
															value={model.metadataSource}
															onChange={(e) =>
																setModelSource(
																	candidate.id,
																	e.target.value as PiModelMetadataSource,
																)
															}
															className="rounded-md border border-border bg-background p-1 text-xs"
														>
															<option value="catalog">Pi 内置目录</option>
															<option value="explicit">自定义元数据</option>
														</select>
														{model.metadataSource === "explicit" && (
															<Button
																type="button"
																variant="ghost"
																size="sm"
																aria-label={`${candidate.id} 编辑元数据`}
																onClick={() => toggleExpand(candidate.id)}
															>
																{expandedIds.includes(candidate.id)
																	? "收起元数据"
																	: "编辑元数据"}
															</Button>
														)}
													</>
												)}
											</div>
											{selected &&
												model &&
												model.metadataSource === "explicit" &&
												expandedIds.includes(candidate.id) && (
													<div className="grid gap-2 px-3 pb-3 md:grid-cols-4">
														<div className="space-y-1">
															<Label className="text-xs">上下文窗口（未确认）</Label>
															<Input
																aria-label={`${candidate.id} 上下文窗口`}
																type="number"
																min={1}
																value={model.metadata.contextWindow}
																onChange={(e) =>
																	patchModelMetadata(candidate.id, {
																		contextWindow: Number(e.target.value) || 1,
																	})
																}
															/>
														</div>
														<div className="space-y-1">
															<Label className="text-xs">最大输出 token（未确认）</Label>
															<Input
																aria-label={`${candidate.id} 最大输出`}
																type="number"
																min={1}
																value={model.metadata.maxTokens}
																onChange={(e) =>
																	patchModelMetadata(candidate.id, {
																		maxTokens: Number(e.target.value) || 1,
																	})
																}
															/>
														</div>
														<div className="space-y-1">
															<Label className="text-xs">输入成本 USD / 百万 token（未确认）</Label>
															<Input
																aria-label={`${candidate.id} 输入成本`}
																type="number"
																min={0}
																step="0.01"
																value={model.metadata.cost.input}
																onChange={(e) =>
																	patchModelMetadata(candidate.id, {
																		cost: {
																			...model.metadata.cost,
																			input: Number(e.target.value) || 0,
																		},
																	})
																}
															/>
														</div>
														<div className="space-y-1">
															<Label className="text-xs">输出成本 USD / 百万 token（未确认）</Label>
															<Input
																aria-label={`${candidate.id} 输出成本`}
																type="number"
																min={0}
																step="0.01"
																value={model.metadata.cost.output}
																onChange={(e) =>
																	patchModelMetadata(candidate.id, {
																		cost: {
																			...model.metadata.cost,
																			output: Number(e.target.value) || 0,
																		},
																	})
																}
															/>
														</div>
													</div>
												)}
										</div>
									);
								})}
							</div>
						)}
					</div>


					{error && (
						<p data-testid="pi-provider-error" className="text-sm text-destructive">
							{error}
						</p>
					)}
					{notice && (
						<p data-testid="pi-provider-notice" className="text-sm text-muted-foreground">
							{notice}
						</p>
					)}
					{loaded && providers.length === 0 && (
						<p className="text-sm text-muted-foreground">尚未配置 Provider</p>
					)}
					<div className="space-y-2">
						{providers.map((item) => (
							<div
								key={item.id}
								className="flex flex-wrap items-center gap-3 rounded-md border border-border/70 p-3 text-sm"
							>
								<StatusChip
									label={item.configurationState === "ready" ? "可用" : "需配置"}
									tone={item.configurationState === "ready" ? "success" : "danger"}
								/>
								<span className="font-medium">{item.name}</span>
								<span>{item.protocol ?? "未配置协议"}</span>
								<span className="text-muted-foreground">{item.runtimeProviderId}</span>
								<span className="text-xs text-muted-foreground">
									模型 {item.models.length} · 内置目录{" "}
									{item.models.filter((m) => m.metadataSource === "catalog").length} ·
									凭据 {item.credentialIds.length} · revision {item.revision}
								</span>
								<Button type="button" variant="outline" onClick={() => startEdit(item)}>
									编辑
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={() => void validateProvider(item.id)}
								>
									验证
								</Button>
							</div>
						))}
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>凭据</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<p className="text-xs text-muted-foreground">
						API Key 只发送到 Server 加密存储，Client 仅在运行期内存中持有；
						列表不显示明文或密文，指纹为 sha256 前 8 位。凭据在接入 Provider 时创建。
					</p>
					{loaded && credentials.length === 0 && (
						<p className="text-sm text-muted-foreground">尚未配置凭据</p>
					)}
					<div className="space-y-2">
						{credentials.map((item) => (
							<div
								key={item.id}
								className="flex flex-wrap items-center gap-3 rounded-md border border-border/70 p-3 text-sm"
							>
								<StatusChip
									label={item.revokedAt ? "已撤销" : "启用"}
									tone={item.revokedAt ? "danger" : "success"}
								/>
								<span className="font-medium">{item.name}</span>
								<span className="text-muted-foreground">{item.providerName}</span>
								<code className="rounded bg-muted px-1.5 py-0.5">{item.fingerprint}</code>
								<span className="text-xs text-muted-foreground">
									keyVersion {item.keyVersion}
								</span>
								<span className="text-xs text-muted-foreground">
									最近使用：{item.lastUsedAt ?? "从未"}
								</span>
								{!item.revokedAt && (
									<Button
										type="button"
										variant="outline"
										onClick={() => void revokeCredential(item.id)}
									>
										撤销
									</Button>
								)}
							</div>
						))}
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
