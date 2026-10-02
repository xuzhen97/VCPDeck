import { useCallback, useEffect, useState } from "react";
import type { ClientInfo, GitSshStatus, GitSshTargetState } from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { apiErrorMessage } from "@/api/error-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** 分发状态 → 稳定中文文案（不把本地清理表述为 Git 服务已撤销）。 */
const STATE_COPY: Record<GitSshTargetState, string> = {
	pending: "待同步（等待 Client 确认）",
	installed: "已安装",
	"clear-pending": "待清理",
	cleared: "已清理",
	failed: "失败",
	ambiguous: "重复连接（已暂停下发）",
	unsupported: "不支持（未上报兼容能力）",
};

/** 原因码 → 可诊断说明；未知码原样展示（不猜测含义）。 */
const REASON_COPY: Record<string, string> = {
	GIT_SSH_KEY_UNAVAILABLE: "Server 缺少 Git SSH 根密钥，或目标机无法安全持久化",
	GIT_SSH_INSTALL_FAILED: "目标机安装失败（权限或写盘被拒绝）",
	GIT_SSH_CLEAR_FAILED: "目标机清理失败",
	GIT_SSH_UNSUPPORTED: "目标机未上报兼容能力",
};

/**
 * Git SSH 共享密钥管理面板（ADR-0037 / ADR-0038）。
 *
 * 只展示公钥、指纹与分发状态；Server 不提供任何读取私钥的入口。
 */
export function GitSshPanel() {
	const sdk = useSdk();
	const [status, setStatus] = useState<GitSshStatus | null>(null);
	const [clients, setClients] = useState<ClientInfo[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [confirmingGenerate, setConfirmingGenerate] = useState(false);
	const [loaded, setLoaded] = useState(false);

	const load = useCallback(async () => {
		try {
			const [current, clientList] = await Promise.all([
				sdk.gitSsh.status(),
				sdk.clients.list(),
			]);
			setStatus(current);
			setClients(clientList);
			setSelected(
				new Set(
					current.targets
						.filter((target) => target.desiredVersion !== null)
						.map((target) => target.clientId),
				),
			);
		} catch (cause) {
			setError(apiErrorMessage(cause, "无法读取 Git SSH 状态"));
		} finally {
			setLoaded(true);
		}
	}, [sdk]);

	useEffect(() => {
		void load();
	}, [load]);

	// 状态轮询：同步刷新分发状态与 Client 能力，但不重置 selected，避免打断勾选。
	// Client 更新并重注册后能力会变化；只轮询 status 会让“能力不可用”提示长期滞留。
	useEffect(() => {
		const timer = setInterval(() => {
			void Promise.all([sdk.gitSsh.status(), sdk.clients.list()])
				.then(([current, clientList]) => {
					setStatus(current);
					setClients(clientList);
				})
				.catch(() => {
					// 瞬时失败不弹错、不覆盖页面上的真实状态。
				});
		}, 3000);
		return () => clearInterval(timer);
	}, [sdk]);

	async function generate() {
		setError(null);
		setNotice(null);
		setConfirmingGenerate(false);
		try {
			const info = await sdk.gitSsh.generate();
			setNotice(
				`已生成第 ${info.version} 代密钥。请把下面的公钥登记到 Git 服务，再选择需要分发的机器。`,
			);
			await load();
		} catch (cause) {
			await load();
			setError(apiErrorMessage(cause, "Git SSH 密钥生成失败"));
		}
	}

	async function saveTargets() {
		setError(null);
		setNotice(null);
		try {
			await sdk.gitSsh.setTargets([...selected].sort());
			setNotice("已保存分发范围；离线机器会在重连后自动同步。");
			await load();
		} catch (cause) {
			await load();
			setError(apiErrorMessage(cause, "Git SSH 选机更新失败"));
		}
	}

	function toggle(clientId: string) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(clientId)) next.delete(clientId);
			else next.add(clientId);
			return next;
		});
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Git SSH 共享密钥</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="text-sm text-amber-300">
					选机仅控制运维分发，不提供每机安全隔离：持有共享 PSK 的机器可以冒用已选 Client ID。任何受信机器或
					PSK 泄漏，都按整套 Git 私钥可能泄漏处置。
				</p>
				<p className="text-xs text-muted-foreground">
					「已清理」只表示该机器本地受管副本已删除，不代表 Git 服务已撤销访问；可靠排除需要在 Git 服务移除旧公钥并轮换新密钥。
				</p>

				{error && (
					<p data-testid="git-ssh-error" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{notice && (
					<p data-testid="git-ssh-notice" className="text-sm text-emerald-400">
						{notice}
					</p>
				)}

				{status?.key ? (
					<div className="space-y-2 rounded-md border border-border/70 p-3 text-sm">
						<p>
							当前密钥：第 {status.key.version} 代｜指纹{" "}
							<code data-testid="git-ssh-fingerprint">{status.key.fingerprint}</code>
						</p>
						<textarea
							aria-label="公钥"
							data-testid="git-ssh-public-key"
							readOnly
							rows={2}
							className="w-full rounded bg-muted p-2 font-mono text-xs"
							value={status.key.publicKey}
						/>
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								void navigator.clipboard?.writeText(status.key?.publicKey ?? "");
							}}
						>
							复制公钥
						</Button>
					</div>
				) : (
					<p data-testid="git-ssh-no-key" className="text-sm text-muted-foreground">
						尚未生成密钥。
					</p>
				)}

				<div className="flex flex-wrap items-center gap-2">
					{confirmingGenerate ? (
						<>
							<Button type="button" variant="destructive" onClick={() => void generate()}>
								确认生成新密钥（需要重新在 Git 服务登记公钥）
							</Button>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setConfirmingGenerate(false)}
							>
								取消
							</Button>
						</>
					) : (
						<Button type="button" onClick={() => setConfirmingGenerate(true)}>
							{status?.key ? "轮换密钥" : "生成密钥"}
						</Button>
					)}
				</div>

				<div className="space-y-2">
					<p className="text-sm font-medium">分发到机器</p>
					{loaded && clients.length === 0 && (
						<p className="text-sm text-muted-foreground">没有已注册 Client</p>
					)}
					{clients.map((client) => (
						<label
							key={client.clientId}
							className="flex items-center gap-2 text-sm"
						>
							<input
								type="checkbox"
								data-testid={`git-ssh-target-${client.clientId}`}
								checked={selected.has(client.clientId)}
								onChange={() => toggle(client.clientId)}
							/>
							{client.name ?? client.hostname}
						</label>
					))}
					<Button type="button" onClick={() => void saveTargets()} disabled={!status?.key}>
						保存分发范围
					</Button>
				</div>

				{status && status.targets.length > 0 && (
					<ul className="space-y-1 text-xs">
						{status.targets.map((target) => {
							const capabilityUnavailable =
								target.desiredVersion !== null &&
								(target.state === "installed" || target.state === "pending") &&
								clients.find((client) => client.clientId === target.clientId)
									?.capabilityDetails?.gitSsh?.available === false;
							return (
								<li key={target.clientId} data-testid={`git-ssh-state-${target.clientId}`}>
									{target.clientId}：
									{capabilityUnavailable
										? "Git SSH 能力不可用（本地密钥可能已落盘，不能确认受管 SSH 已生效）"
										: target.reasonCode
											? (REASON_COPY[target.reasonCode] ?? target.reasonCode)
											: STATE_COPY[target.state]}
									{target.observedVersion !== null && `（第 ${target.observedVersion} 代）`}
								</li>
							);
						})}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}
