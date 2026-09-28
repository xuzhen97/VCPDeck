import type { ClientInfo } from "@vcpdeck/shared";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useSdk } from "@/api/context";
import { useResource } from "@/api/hooks/use-resource";
import { ErrorState, LoadingState } from "@/components/async-state";
import { PiPanel } from "@/pages/pi-panel";

/** 机器不可用于 Agent 对话的原因；可用于对话时返回 null。 */
export function machineUnavailableReason(client: ClientInfo): string | null {
	if (client.online !== true) return "离线";
	if (client.capabilityDetails?.pi?.available !== true) return "不支持 Pi";
	return null;
}

/**
 * Agent 对话视图：在全局 Agent 模块内提供机器上下文选择，再复用 `PiPanel`。
 *
 * 对话依赖机器上下文（项目目录与 Session 都在目标机上），因此未选机器时只渲染空态，
 * 不挂载 `PiPanel`。选中的机器写入 `?client=`，刷新与深链都能回到同一台机器。
 */
export function AgentChatPanel() {
	const sdk = useSdk();
	const [searchParams, setSearchParams] = useSearchParams();
	const load = useCallback(
		(signal: AbortSignal) => sdk.clients.list(signal),
		[sdk],
	);
	const resource = useResource(load);
	const clients = useMemo(() => resource.data ?? [], [resource.data]);
	const requestedId = searchParams.get("client") ?? "";
	const selected = clients.find(
		(client) =>
			client.clientId === requestedId &&
			machineUnavailableReason(client) === null,
	);

	if (resource.loading) return <LoadingState label="正在加载机器列表…" />;
	if (resource.error || !resource.data)
		return <ErrorState message="无法加载机器列表" onRetry={resource.reload} />;

	function select(clientId: string) {
		// 只改 URL，不存组件态：URL 是机器上下文的唯一来源
		setSearchParams(clientId ? { client: clientId } : {}, { replace: true });
	}

	const picker = (
		<div className="space-y-1.5">
			{/* 不用 label/htmlFor：同一 slot 会被渲染两次（桌面左栏 + 常驻抽屉），
			    id 关联会产生重复 id；直接用 aria-label 提供可访问名称 */}
			<select
				aria-label="机器"
					title="离线与不支持 Pi 的机器不可选；项目与会话在目标机器上。"
					className="min-h-9 w-full rounded-lg border border-input bg-background/60 px-2 text-sm"
					value={selected?.clientId ?? ""}
					onChange={(event) => select(event.target.value)}
				>
					<option value="">选择机器…</option>
					{clients.map((client) => {
						const reason = machineUnavailableReason(client);
						return (
							<option
								key={client.clientId}
								value={client.clientId}
								disabled={reason !== null}
							>
								{client.name}（{client.hostname}）
								{reason ? ` · ${reason}` : ""}
							</option>
							);
						})}
			</select>
		</div>
	);

	if (!selected) {
		const requested = clients.find(
			(client) => client.clientId === requestedId,
		);
		return (
			<div className="flex h-full min-h-0 flex-col gap-3 p-2 lg:flex-row">
				{/* 选择器必须常驻可见：用 hidden 藏起来会让窄屏用户无任何入口 */}
				<aside
					aria-label="机器选择"
					className="shrink-0 rounded border border-border p-3 lg:w-72"
				>
					{picker}
				</aside>
				<section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded border border-border p-6 text-center">
					<p className="font-medium">选择一台机器开始对话</p>
					<p className="text-sm text-muted-foreground">
						对话需要机器上下文（项目目录与 Session 都在目标机上），所以先选机器。
					</p>
					{requestedId && (
						<p
							data-testid="agent-chat-requested-note"
							role="status"
							aria-live="polite"
							className="text-sm text-amber-400"
						>
							{requested
								? `?client=${requestedId} 不可用（${machineUnavailableReason(requested)}）。`
								: `?client=${requestedId} 不存在。`}
						</p>
					)}
				</section>
			</div>
		);
	}

	return <PiPanel client={selected} leftSlot={picker} agentChatLayout />;
}
