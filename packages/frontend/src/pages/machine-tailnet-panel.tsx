import {
	parseTailnetJobResult,
	type TailnetJobPayload,
	type TailnetJobResult,
	type TailnetKeyInfo,
	type TailnetKeyUse,
	type TailnetReuse,
	type TailnetSnapshot,
	type TailnetStatus,
} from "@vcpdeck/shared";
import { VcpDeckApiError } from "@vcpdeck/sdk";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@/api/context";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";

/** 观测时效阈值；只影响 UI 提示，不证明网络可达。 */
const OBSERVATION_STALE_MS = 120_000;

const REUSE_LABELS: Record<TailnetReuse, string> = {
	unknown: "复用性未声明",
	single: "一次性凭据",
	reusable: "可复用凭据",
};

const USE_LABELS: Record<TailnetKeyUse, string> = {
	available: "可用",
	reserved: "已预留",
	spent: "已消耗",
	uncertain: "状态不确定",
};

/**
 * 只有 `available` 能被直接预留；其余状态点下去只会拿到 409，所以不让选并说明原因。
 *
 * 例外是 ADR-0064 的逐次确认：`uncertain` 且导入时声明为 `reusable` 的记录，
 * 操作者确认该 key 仍有效后可以再下发一次。
 */
const UNUSABLE_HINTS: Partial<Record<TailnetKeyUse, string>> = {
	reserved: "正在被某个 Job 使用",
	spent: "已使用过，不能重复使用",
	uncertain: "上次下发后结果不明，需重新导入新密钥",
};

/** `uncertain` 且声明可复用时，确认后仍可再下发一次（ADR-0064）。 */
const REUSABLE_UNCERTAIN_HINT = "上次下发后结果不明；确认该 key 仍有效时可勾选下方选项重试";

/**
 * 机器页可能遇到的操作失败给出下一步动作。
 *
 * 保留稳定 code 便于对照文档与日志，同时避免只显示一个错误码让操作者无从下手。
 */
const ERROR_HINTS: Record<string, string> = {
	TAILNET_KEY_BUSY:
		"该凭据当前不可用（已预留、已消耗或状态不确定）；请改用可用凭据，或到设置页重新导入一枚新 Auth key。",
	TAILNET_KEY_UNAVAILABLE:
		"服务端的 Tailnet 密钥服务或根密钥不可用；先确认 Server 已升级到 0.23.12 以上，否则核对数据目录的 data/tailnet/root.key 是否与库中凭据配对。",
	TAILNET_EXISTING_CONFIG:
		"该机器已有 Tailscale 安装或既有身份，VCPDeck 不覆盖；请人工核对现状后再决定。",
	TAILNET_JOIN_FAILED:
		"入网被 Tailscale 拒绝：确认授权密钥未过期、未被撤销，且机器时间正确。",
	TAILNET_OPERATION_BUSY: "该机器已有在途的 Tailnet 管理 Job，等它结束后再试。",
};

const INSTALLED_LABELS: Record<TailnetSnapshot["installed"], string> = {
	yes: "已安装",
	no: "未安装",
	unknown: "安装状态未知",
};

const SERVICE_LABELS: Record<TailnetSnapshot["service"], string> = {
	running: "运行中",
	stopped: "已停止",
	unknown: "未知",
};

const BACKEND_LABELS: Record<TailnetSnapshot["backend"], string> = {
	running: "运行中",
	"needs-login": "需要登录",
	"needs-approval": "等待管理端批准",
	stopped: "已停止",
	unknown: "未知",
};

const STAGE_LABELS: Record<TailnetJobResult["stage"], string> = {
	inspected: "已刷新观测",
	installed: "已安装",
	joined: "已加入",
	"existing-login": "已有登录，未使用凭据",
	"awaiting-approval": "等待管理端批准",
	interrupted: "已中断",
};

const STATUS_LABELS: Record<string, string> = {
	pending: "已排队",
	running: "执行中",
	disconnected: "连接中断",
	done: "已完成",
	error: "失败",
	cancelled: "已取消",
};

interface ActiveJob {
	jobId: string;
	status: string;
	stage: TailnetJobResult["stage"] | null;
	errorCode: string | null;
}

function readStage(result: Record<string, unknown> | null): {
	stage: TailnetJobResult["stage"] | null;
} {
	if (result === null) return { stage: null };
	try {
		return { stage: parseTailnetJobResult(result).stage };
	} catch {
		return { stage: null };
	}
}

function describeError(cause: unknown): string {
	if (cause instanceof VcpDeckApiError && cause.code?.startsWith("TAILNET_")) {
		const hint = ERROR_HINTS[cause.code];
		return hint
			? `操作失败（${cause.code}）：${hint}`
			: `操作失败（${cause.code}）`;
	}
	return "操作失败，请稍后重试";
}

function formatObservedAt(value: string): string {
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? "时间未知" : time.toLocaleString();
}

function isStale(snapshot: TailnetSnapshot): boolean {
	const time = Date.parse(snapshot.observedAt);
	return Number.isFinite(time) && Date.now() - time > OBSERVATION_STALE_MS;
}

/**
 * 机器概览内的 Tailnet 观测与管理面板（ADR-0062）。
 *
 * 只展示 Client 上报的只读摘要与凭据安全元数据；安装与入网必须由操作者显式点击，
 * 不在挂载或刷新时自动执行。
 */
export function MachineTailnetPanel({ clientId }: { clientId: string }) {
	const sdk = useSdk();
	const [status, setStatus] = useState<TailnetStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [keys, setKeys] = useState<TailnetKeyInfo[]>([]);
	const [reloadToken, setReloadToken] = useState(0);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [job, setJob] = useState<ActiveJob | null>(null);
	const [selectedKeyId, setSelectedKeyId] = useState("");
	const [installIfMissing, setInstallIfMissing] = useState(false);
	/**
	 * ADR-0064：对「可复用 + 状态不确定」凭据的逐次确认。
	 *
	 * 记住「确认的是哪一枚」而不是一个布尔值：换凭据自动失效，不需要额外的重置副作用。
	 */
	const [confirmedKeyId, setConfirmedKeyId] = useState<string | null>(null);

	const reload = useCallback(() => {
		setReloadToken((value) => value + 1);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		let active = true;
		setStatusError(null);
		sdk.tailnet
			.status(clientId, controller.signal)
			.then((next) => {
				if (active) setStatus(next);
			})
			.catch(() => {
				if (active) setStatusError("无法读取 Tailnet 状态");
			});
		sdk.tailnet
			.listKeys({ page: 1, pageSize: 20 }, controller.signal)
			.then((page) => {
				if (active) setKeys(page.data);
			})
			.catch(() => {
				// 凭据列表失败不阻断只读观测；列表保持上次结果。
			});
		return () => {
			active = false;
			controller.abort();
		};
	}, [sdk, clientId, reloadToken]);

	const canOperate =
		status !== null && status.online && status.supported && !busy;

	const availableKeys = keys.filter((key) => key.use === "available");
	const reusableUncertainKeys = keys.filter(
		(key) => key.use === "uncertain" && key.declaredReuse === "reusable",
	);
	const selectedKey = keys.find((key) => key.id === selectedKeyId) ?? null;
	// 选中项能否被服务端预留：可用的总是能；状态不确定的只有「可复用 + 显式确认」才行。
	const selectedReusableUncertain =
		selectedKey?.use === "uncertain" && selectedKey.declaredReuse === "reusable";
	const allowUncertainReuse =
		selectedReusableUncertain && confirmedKeyId === selectedKeyId;
	const canJoin =
		canOperate &&
		(selectedKey?.use === "available" ||
			(selectedReusableUncertain && allowUncertainReuse));

	// Job 结束会改变凭据状态；选中项再也不能用时清空，避免点下去必然收到 409。
	useEffect(() => {
		if (selectedKeyId.length === 0) return;
		const current = keys.find((key) => key.id === selectedKeyId);
		const usable =
			current?.use === "available" ||
			(current?.use === "uncertain" && current.declaredReuse === "reusable");
		if (!usable) {
			setSelectedKeyId("");
			setConfirmedKeyId(null);
		}
	}, [keys, selectedKeyId]);

	async function runManage(payload: TailnetJobPayload) {
		setBusy(true);
		setActionError(null);
		setNotice(null);
		setJob(null);
		try {
			const created = await sdk.tailnet.manage(clientId, payload);
			setJob({
				jobId: created.jobId,
				status: created.status,
				stage: null,
				errorCode: null,
			});
			if (typeof sdk.jobs?.wait === "function") {
				const finished = await sdk.jobs.wait(created.jobId, {
					delays: [1000, 2000, 5000],
					onUpdate: (next) => {
						setJob({
							jobId: next.jobId,
							status: next.status,
							stage: readStage(next.result).stage,
							errorCode: next.errorCode,
						});
					},
				});
				setJob({
					jobId: finished.jobId,
					status: finished.status,
					stage: readStage(finished.result).stage,
					errorCode: finished.errorCode,
				});
			}
			reload();
		} catch (cause) {
			// 失败也可能改变凭据状态（例如交付后落 uncertain），刷新一次以免界面停留在旧值。
			reload();
			setActionError(describeError(cause));
		} finally {
			setBusy(false);
		}
	}

	async function cancelJob() {
		if (!job) return;
		setBusy(true);
		setActionError(null);
		try {
			await sdk.jobs.cancel(job.jobId);
			setNotice("已请求取消当前管理 Job。取消不会自动撤销已安装软件或已生效的登录。");
			reload();
		} catch (cause) {
			setActionError(describeError(cause));
		} finally {
			setBusy(false);
		}
	}

	const snapshot = status?.snapshot ?? null;
	const showHistory = snapshot !== null && status !== null && !status.online;
	const showStale = snapshot !== null && status?.online === true && isStale(snapshot);

	return (
		<Card>
			<CardHeader className="pb-4">
				<CardTitle>Tailnet</CardTitle>
				<p className="mt-1 text-sm text-muted-foreground">
					只读观测来自 Client 的官方 CLI；观测成功不代表端口可达，也不改变公网回退。
				</p>
			</CardHeader>
			<CardContent className="space-y-5 text-sm">
				{statusError ? (
					<div className="flex items-center justify-between gap-3">
						<p className="text-destructive">{statusError}</p>
						<Button type="button" size="sm" variant="outline" onClick={reload}>
							重试
						</Button>
					</div>
				) : status === null ? (
					<p className="text-muted-foreground">正在读取 Tailnet 状态…</p>
				) : (
					<>
						<section aria-label="Tailnet 观测" className="space-y-2">
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="font-medium">当前观测</h3>
								{showHistory && (
									<StatusChip label="历史观测 / 离线" tone="neutral" />
								)}
								{showStale && (
									<StatusChip label="观测可能过期" tone="warning" />
								)}
							</div>
							{snapshot === null ? (
								<p className="text-muted-foreground">未知 / 未报告</p>
							) : (
								<dl className="grid gap-2 sm:grid-cols-2">
									<div>
										<dt className="text-muted-foreground">安装</dt>
										<dd>{INSTALLED_LABELS[snapshot.installed]}</dd>
									</div>
									<div>
										<dt className="text-muted-foreground">版本</dt>
										<dd>{snapshot.version ?? "未知"}</dd>
									</div>
									<div>
										<dt className="text-muted-foreground">服务</dt>
										<dd>{SERVICE_LABELS[snapshot.service]}</dd>
									</div>
									<div>
										<dt className="text-muted-foreground">后端</dt>
										<dd>{BACKEND_LABELS[snapshot.backend]}</dd>
									</div>
									<div>
										<dt className="text-muted-foreground">节点名称</dt>
										<dd>{snapshot.nodeName ?? "未知"}</dd>
									</div>
									<div>
										<dt className="text-muted-foreground">Tailnet 地址</dt>
										<dd>
											{[...snapshot.ipv4, ...snapshot.ipv6].join(", ") || "无"}
										</dd>
									</div>
									<div>
										<dt className="text-muted-foreground">观测时间</dt>
										<dd>{formatObservedAt(snapshot.observedAt)}</dd>
									</div>
									{snapshot.errorCode && (
										<div>
											<dt className="text-muted-foreground">最近错误</dt>
											<dd>{snapshot.errorCode}</dd>
										</div>
									)}
								</dl>
							)}
						</section>

						<section aria-label="Tailnet 凭据" className="space-y-2">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<h3 className="font-medium">Tailnet 凭据</h3>
								<Link
									className="text-sm font-medium text-primary hover:underline"
									to="/settings/tailnet"
								>
									在设置中管理凭据
								</Link>
							</div>
							<p className="text-xs text-muted-foreground">
								只保存名称、声明与使用状态；密钥加密保存且不再回显。声明不代表真实验证。
							</p>
							{keys.length === 0 ? (
								<p className="text-muted-foreground">尚未导入凭据</p>
							) : (
								<>
									<Label htmlFor="tailnet-key-select">选择 Tailnet 凭据</Label>
									<select
										id="tailnet-key-select"
										className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
										value={selectedKeyId}
										onChange={(event) => {
											setSelectedKeyId(event.target.value);
											// 换凭据就重新确认：上一枚 key 的确认不能沿用到这一次
											setConfirmedKeyId(null);
										}}
									>
										<option value="">未选择</option>
										{keys.map((key) => {
											const selectable =
												key.use === "available" ||
												(key.use === "uncertain" &&
													key.declaredReuse === "reusable");
											return (
												<option key={key.id} value={key.id} disabled={!selectable}>
													{!selectable
														? `${key.name}（${USE_LABELS[key.use]}，不可用于加入）`
														: key.use === "available"
															? key.name
															: `${key.name}（状态不确定，确认后可重试）`}
												</option>
											);
										})}
									</select>
									<ul className="space-y-2">
										{keys.map((key) => {
											const reusableUncertain =
												key.use === "uncertain" && key.declaredReuse === "reusable";
											const hint = reusableUncertain
												? REUSABLE_UNCERTAIN_HINT
												: UNUSABLE_HINTS[key.use];
											return (
												<li
													key={key.id}
													className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
												>
													<span className="font-medium">{key.name}</span>
													<span>{REUSE_LABELS[key.declaredReuse]}</span>
													<span>使用：{USE_LABELS[key.use]}</span>
													{hint && (
														<span className="text-xs text-muted-foreground">
															{hint}
														</span>
													)}
													{key.declaredExpiresAt && (
														<span className="text-xs text-muted-foreground">
															声明过期于{" "}
															{formatObservedAt(key.declaredExpiresAt)}
														</span>
													)}
												</li>
											);
										})}
									</ul>
									{availableKeys.length === 0 && (
										<p className="text-xs text-destructive">
											没有可直接使用的凭据：只有「可用」的凭据能被直接预留。
											{reusableUncertainKeys.length > 0
												? "已声明可复用的「状态不确定」凭据在勾选确认后仍可再下发一次——前提是该 Auth key 未过期且未被撤销。"
												: "状态不确定表示上次下发后结果不明，一次性 Auth key 不能保证可重复使用，因此 VCPDeck 不会自动重试；请先到设置页导入一枚新的 Auth key。"}
										</p>
									)}
								</>
							)}
						</section>

						<section aria-label="Tailnet 管理" className="space-y-3">
							<h3 className="font-medium">管理操作</h3>
							{!status.supported && (
								<p className="text-xs text-muted-foreground">
									该 Client 未声明 Tailnet 管理能力；只可查看历史观测。
								</p>
							)}
							<div className="flex flex-wrap items-center gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={!canOperate}
									onClick={() => void runManage({ action: "inspect" })}
								>
									<RefreshCw className="size-4" />
									刷新 Tailnet 观测
								</Button>
							</div>
							<label className="flex items-start gap-2 text-xs text-muted-foreground">
								<input
									type="checkbox"
									checked={installIfMissing}
									disabled={!canOperate}
									onChange={(event) => setInstallIfMissing(event.target.checked)}
								/>
								<span>
									如果尚未安装，允许安装官方 Tailscale 1.104.5（需要 Client
									管理员/root 权限；已有安装或状态时不覆盖）
								</span>
							</label>
							{selectedReusableUncertain && (
								<label className="flex items-start gap-2 text-xs text-muted-foreground">
									<input
										type="checkbox"
										checked={allowUncertainReuse}
										disabled={!canOperate}
										onChange={(event) =>
											setConfirmedKeyId(
												event.target.checked ? selectedKeyId : null,
											)
										}
									/>
									<span>
										我确认这枚 Auth key 仍然有效且未被撤销，允许在「状态不确定」的情况下再下发一次
										（一次性 key 不能重试；确认错误只会再失败一次，不会自动重试）
									</span>
								</label>
							)}
							<div className="flex flex-wrap items-center gap-2">
								<Button
									type="button"
									size="sm"
									disabled={!canJoin}
									onClick={() =>
										void runManage({
											action: "ensure",
											credentialId: selectedKeyId,
											installIfMissing,
											...(allowUncertainReuse && selectedReusableUncertain
												? { allowUncertainReuse: true }
												: {}),
										})
									}
								>
									<ShieldAlert className="size-4" />
									加入 Tailnet（使用选中凭据）
								</Button>
							</div>
							<p className="text-xs text-muted-foreground">
								加入 Tailnet 会改变该机器的网络出口与 DNS
								策略；仅在明确需要时执行。已有登录身份时不会自动覆盖。
							</p>
							{actionError && <p className="text-destructive">{actionError}</p>}
							{job && (
								<div
									data-testid="tailnet-job"
									className="space-y-1 rounded-md border border-border/70 px-3 py-2"
								>
									<p>
										Job {job.jobId}：
										{job.stage
											? STAGE_LABELS[job.stage]
											: (STATUS_LABELS[job.status] ?? job.status)}
									</p>
									{job.errorCode && (
										<p className="text-destructive">错误码：{job.errorCode}</p>
									)}
									<div className="flex flex-wrap items-center gap-2">
										<Button
											type="button"
											size="sm"
											variant="destructive"
											disabled={busy || job.status === "cancelled"}
											onClick={() => void cancelJob()}
										>
											取消 Job
										</Button>
										<span className="text-xs text-muted-foreground">
											取消不会自动撤销已安装软件、已生效登录或其他机器的改动。
										</span>
									</div>
								</div>
							)}
							{notice && <p className="text-xs text-muted-foreground">{notice}</p>}
						</section>
					</>
				)}
			</CardContent>
		</Card>
	);
}
