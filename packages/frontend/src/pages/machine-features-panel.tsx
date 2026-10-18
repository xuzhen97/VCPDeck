/**
 * 功能条目面板（ADR-0056）。
 *
 * 只负责「看见 + 维护」：验证不在 UI 发起（浏览器 CORS 打不到内网，
 * Server 代抓 URL 会形成 SSRF 面），抽屉里给出可复制的验证命令。
 */
import type { FeatureInfo } from "@vcpdeck/shared";
import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@/api/context";
import { ErrorState, LoadingState } from "@/components/async-state";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { copyText } from "@/lib/clipboard";

/** 证据年龄文案：缺失、失败、过期、新鲜四种；退役条目显式标注。 */
function freshnessLabel(feature: FeatureInfo): string {
	if (feature.freshness === "never" || feature.lastVerifiedAt === null) {
		return feature.status === "retired" ? "已退役（从未验证）" : "从未验证";
	}
	const days = Math.floor(
		(Date.now() - new Date(feature.lastVerifiedAt).getTime()) / 86_400_000,
	);
	const when = days === 0 ? "今天" : `${days} 天前`;
	// 最近一次验证失败时不能显示“通过”，否则与 draft 状态自相矛盾
	const base =
		feature.lastVerifiedOk === false
			? `最新验证失败（${when}）`
			: feature.freshness === "stale"
				? `已 ${days} 天未验证`
				: `${when}通过`;
	return feature.status === "retired" ? `已退役（${base}）` : base;
}

/** 功能条目面板；不传 clientId 时跨机器展示。 */
export function MachineFeaturesPanel({ clientId }: { clientId?: string }) {
	const sdk = useSdk();
	const [items, setItems] = useState<FeatureInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<FeatureInfo | null>(null);
	const [showRetired, setShowRetired] = useState(false);
	const [revision, setRevision] = useState(0);
	const reload = useCallback(() => setRevision((value) => value + 1), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision 是外部重载计数器，只用于触发重新拉取
	useEffect(() => {
		const controller = new AbortController();
		setError(null);
		const request = clientId
			? sdk.features.listByClient(clientId, controller.signal)
			: sdk.features.list({ pageSize: 100 }, controller.signal);
		request
			.then((page) => {
				if (!controller.signal.aborted) setItems(page.data);
			})
			.catch(() => {
				if (!controller.signal.aborted) setError("无法加载功能条目");
			});
		return () => controller.abort();
	}, [sdk, clientId, revision]);

	if (error) return <ErrorState message={error} onRetry={reload} />;
	if (items === null) return <LoadingState label="正在加载功能…" />;
	if (items.length === 0) {
		return (
			<Card>
				<CardContent className="py-12 text-center text-sm text-muted-foreground">
					这里还没有登记任何功能。用 <code>vcpdeck features add</code> 登记并验证一次。
				</CardContent>
			</Card>
		);
	}
	const retiredCount = items.filter((item) => item.status === "retired").length;
	const visible = showRetired
		? items
		: items.filter((item) => item.status !== "retired");
	return (
		<div className="space-y-3">
			<p data-testid="feature-warning" className="text-xs text-amber-600">
				active 只代表声明，不代表现在可用；判断有效请先看证据年龄，并用
				<code className="mx-1">vcpdeck features verify &lt;slug&gt;</code>
				重新验证一次。
			</p>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">
					共 {items.length} 条，显示 {visible.length} 条
					{retiredCount > 0 && !showRetired
						? `（${retiredCount} 条已退役已隐藏）`
						: ""}
				</p>
				{retiredCount > 0 && (
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						<input
							type="checkbox"
							aria-label="显示已退役"
							checked={showRetired}
							onChange={(event) => setShowRetired(event.target.checked)}
						/>
						显示已退役（{retiredCount}）
					</label>
				)}
			</div>
			{visible.length === 0 ? (
				<Card>
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						这台机器的功能条目都已退役；勾选上方「显示已退役」可查看历史条目。
					</CardContent>
				</Card>
			) : (
				<FeatureTable items={visible} onSelect={setSelected} />
			)}
			{selected && (
				<FeatureDrawer
					feature={selected}
					onClose={() => setSelected(null)}
					onChanged={reload}
				/>
			)}
		</div>
	);
}

function FeatureTable({
	items,
	onSelect,
}: {
	items: FeatureInfo[];
	onSelect: (feature: FeatureInfo) => void;
}) {
	return (
		<Card>
			<CardContent className="overflow-x-auto p-0">
				<table className="w-full text-sm">
					<thead className="border-b border-border/70 text-left text-xs text-muted-foreground">
						<tr>
							<th className="px-4 py-3">功能</th>
							<th className="px-4 py-3">作用域</th>
							<th className="px-4 py-3">状态</th>
							<th className="px-4 py-3">证据</th>
							<th className="px-4 py-3">提供机器</th>
						</tr>
					</thead>
					<tbody>
						{items.map((item) => (
							<tr
								key={item.id}
								data-testid="feature-row"
								onClick={() => onSelect(item)}
								className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-secondary/40"
							>
								<td className="px-4 py-3">
									<div className="font-medium">{item.name}</div>
									<div className="text-xs text-muted-foreground">
										{item.slug}
									</div>
								</td>
								<td className="px-4 py-3">
									{item.scope === "generic" ? "通用" : "本机专属"}
								</td>
								<td className="px-4 py-3">
									<StatusChip label={item.status} />
								</td>
								<td data-testid="feature-freshness" className="px-4 py-3">
									{freshnessLabel(item)}
								</td>
								<td className="px-4 py-3">
									{item.clientName ?? item.clientId}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</CardContent>
		</Card>
	);
}

function FeatureDrawer({
	feature,
	onClose,
	onChanged,
}: {
	feature: FeatureInfo;
	onClose: () => void;
	onChanged: () => void;
}) {
	const sdk = useSdk();
	const verifyCommand = `vcpdeck features verify ${feature.slug} --client ${
		feature.clientName ?? feature.clientId
	}`;

	async function retire() {
		await sdk.features.update(feature.id, { status: "retired" });
		onChanged();
		onClose();
	}

	return (
		<Drawer open onClose={onClose} title={feature.name} size="wide">
			<div className="space-y-4 text-sm">
				<p className="text-muted-foreground">{feature.summary}</p>
				<Field label="调用契约" value={JSON.stringify(feature.invoke, null, 2)} />
				<Field label="验证契约" value={JSON.stringify(feature.verify, null, 2)} />
				<Field
					label="参数"
					value={
						feature.inputs.length === 0
							? "无参数"
							: feature.inputs
									.map(
										(input) =>
											`${input.name}: ${input.type}${
												input.required ? "（必填）" : ""
											} — ${input.description}`,
									)
									.join("\n")
					}
				/>
				<Field label="产物" value={feature.output || "—"} />
				<Field label="备注" value={feature.notes || "—"} />
				<Field
					label="证据"
					value={`${freshnessLabel(feature)}｜${
						feature.lastVerifiedOk === null
							? "无记录"
							: feature.lastVerifiedOk
								? "通过"
								: "失败"
					}｜${feature.lastVerifyEvidence ?? "—"}（来源 ${feature.verifiedVia ?? "—"}）`}
				/>
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={() => void copyText(verifyCommand)}
					>
						复制验证命令
					</Button>
					<Button
						size="sm"
						variant="destructive"
						disabled={feature.status === "retired"}
						onClick={() => void retire()}
					>
						退役
					</Button>
				</div>
			</div>
		</Drawer>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<p className="text-xs text-muted-foreground">{label}</p>
			<pre className="mt-1 whitespace-pre-wrap break-all rounded-md bg-secondary/50 p-2 text-xs">
				{value}
			</pre>
		</div>
	);
}

/** 全局功能库页：跨机器浏览。 */
export function FeaturesPage() {
	return <MachineFeaturesPanel />;
}
