import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PiClientBindingInfo, PiProfileInfo, PiRuntimeStatus } from "@vcpdeck/shared";
import type { ClientInfo } from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { apiErrorMessage } from "@/api/error-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/status-chip";

/** configState → 稳定中文文案（不回显 Server 内部 message）。 */
const CONFIG_STATE_COPY: Record<PiRuntimeStatus["configState"], string> = {
	pending: "未就绪（等待 Server 下发配置）",
	ready: "就绪",
	incompatible: "配置不可用",
	stale: "待换代",
};

/** 原因码 → 可诊断中文说明；未知码原样展示（不猜测含义）。 */
const REASON_COPY: Record<string, string> = {
	PI_CONFIG_UNAVAILABLE: "缺少绑定或 Server 凭据密钥未配置",
	PI_CREDENTIAL_UNAVAILABLE: "凭据不可用（缺失、撤销或 provider 不覆盖）",
	PI_RUNTIME_SPEC_INCOMPATIBLE: "运行配置与当前 Client 不兼容",
	PI_BUNDLE_UNAVAILABLE: "目标机缺少所需资源 Bundle（未上报或版本不匹配）",
};

/**
 * Client runtime 状态与 Profile 绑定：展示 desired/active revision、
 * configState、SDK 版本与缺失模型，便于定位「为什么 Pi 不可用」。
 */
export function PiRuntimePanel() {
	const sdk = useSdk();
	const [clients, setClients] = useState<ClientInfo[]>([]);
	const [profiles, setProfiles] = useState<PiProfileInfo[]>([]);
	const [bindings, setBindings] = useState<PiClientBindingInfo[]>([]);
	const [statuses, setStatuses] = useState<Record<string, PiRuntimeStatus>>({});
	const [selected, setSelected] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);

	const load = useCallback(async () => {
		try {
			const [clientList, profilePage, bindingList] = await Promise.all([
				sdk.clients.list(),
				sdk.pi.profiles.list(),
				sdk.pi.bindings.list(),
			]);
			setClients(clientList);
			setProfiles(profilePage.data);
			setBindings(bindingList);
			const entries = await Promise.all(
				clientList.map(async (client) => {
					try {
						return [client.clientId, await sdk.pi.runtime(client.clientId)] as const;
					} catch {
						return null;
					}
				}),
			);
			const next: Record<string, PiRuntimeStatus> = {};
			for (const entry of entries) {
				if (entry) next[entry[0]] = entry[1];
			}
			setStatuses(next);
		} catch {
			setError("无法读取 Pi 运行时状态");
		} finally {
			setLoaded(true);
		}
	}, [sdk]);

	useEffect(() => {
		void load();
	}, [load]);

	async function bind(e: FormEvent, clientId: string) {
		e.preventDefault();
		setError(null);
		const profileId = selected[clientId];
		try {
			if (!profileId) {
				await sdk.pi.bindings.clear(clientId);
			} else {
				await sdk.pi.bindings.set(clientId, profileId);
			}
			await load();
		} catch (error) {
			// 绑定可能已写入而只是下发失败：先刷新到真实状态，再展示服务端精确原因。
			await load();
			setError(apiErrorMessage(error, "绑定更新失败"));
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Pi · Client 运行时</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="text-xs text-muted-foreground">
					配置由 Server 权威下发；Client 不落盘配置与凭据。
					非「就绪」时 Pi 明确不可用，不会回退到目标机用户自己的 Pi。
				</p>
				{error && (
					<p data-testid="pi-runtime-error" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{loaded && clients.length === 0 && (
					<p className="text-sm text-muted-foreground">没有已注册 Client</p>
				)}
				{clients.map((client) => {
					const status = statuses[client.clientId];
					const bound = bindings.find((b) => b.clientId === client.clientId);
					return (
						<div
							key={client.clientId}
							data-testid={`pi-runtime-${client.clientId}`}
							className="space-y-2 rounded-md border border-border/70 p-3 text-sm"
						>
							<div className="flex flex-wrap items-center gap-3">
								<span className="font-medium">
									{client.name ?? client.hostname}
								</span>
								<StatusChip
									label={
										status ? CONFIG_STATE_COPY[status.configState] : "状态未知"
									}
									tone={status?.configState === "ready" ? "success" : "danger"}
								/>
								{status?.reasonCode && (
									<span data-testid="pi-runtime-reason" className="text-xs text-destructive">
										{REASON_COPY[status.reasonCode] ?? status.reasonCode}
									</span>
								)}
							</div>
							{status && (
								<div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
									<span>desired {status.desiredRuntimeRevision ?? "—"}</span>
									<span>active {status.activeRuntimeRevision ?? "—"}</span>
									<span>Pi SDK {status.piSdkVersion ?? "—"}</span>
									<span>
										协议 {status.runtimeSpecProtocolVersion ?? "未上报"}
									</span>
								</div>
							)}
							{status && status.unavailableModels.length > 0 && (
								<pre
									data-testid="pi-runtime-unavailable"
									className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs"
								>
									{status.unavailableModels
										.map((m) => `${m.provider}/${m.modelId} (${m.reason})`)
										.join("\n")}
								</pre>
							)}
							<form
								onSubmit={(e) => void bind(e, client.clientId)}
								className="flex flex-wrap items-end gap-3"
							>
								<div className="space-y-1.5">
									<Label htmlFor={`pi-bind-${client.clientId}`}>绑定 Profile</Label>
									<select
										id={`pi-bind-${client.clientId}`}
										data-testid={`pi-bind-${client.clientId}`}
										value={selected[client.clientId] ?? bound?.profileId ?? ""}
										onChange={(e) =>
											setSelected((prev) => ({
												...prev,
												[client.clientId]: e.target.value,
											}))
										}
										className="rounded-md border border-border bg-background p-2 text-sm"
									>
										<option value="">（不绑定）</option>
										{profiles.map((profile) => (
											<option key={profile.id} value={profile.id}>
												{profile.name}
											</option>
										))}
									</select>
								</div>
								<Button type="submit" variant="outline">
									保存绑定
								</Button>
							</form>
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}
