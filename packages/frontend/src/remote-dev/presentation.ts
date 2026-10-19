import {
	REMOTE_DEV_TERMINAL_STATES,
	type RemoteDevAgentState,
	type RemoteDevAttachmentMode,
	type RemoteDevSessionInfo,
	type RemoteDevState,
} from "@vcpdeck/shared";

/** 徽章色调，与 `StatusChip` 的 `tone` 取值一致。 */
export type Tone = "success" | "warning" | "danger" | "neutral";

/** 会话状态的中文名与色调。 */
const SESSION_STATE: Record<RemoteDevState, { label: string; tone: Tone }> = {
	starting: { label: "启动中", tone: "warning" },
	active: { label: "运行中", tone: "success" },
	detached: { label: "未附着", tone: "warning" },
	disconnected: { label: "已断开", tone: "warning" },
	interrupted: { label: "已中断", tone: "danger" },
	closing: { label: "关闭中", tone: "warning" },
	closed: { label: "已结束", tone: "neutral" },
	failed: { label: "失败", tone: "danger" },
};

/** agent 状态的中文名与色调。 */
const AGENT_STATE: Record<RemoteDevAgentState, { label: string; tone: Tone }> = {
	starting: { label: "启动中", tone: "warning" },
	ready: { label: "待命", tone: "success" },
	busy: { label: "思考中", tone: "warning" },
	idle: { label: "空闲", tone: "success" },
	exited: { label: "已退出", tone: "neutral" },
	failed: { label: "异常退出", tone: "danger" },
};

/** 附着模式的中文名。 */
const ATTACH_MODE: Record<RemoteDevAttachmentMode, string> = {
	operator: "操作者",
	viewer: "只读旁观",
};

/** 会话状态的展示文案。 */
export function sessionStateBadge(state: RemoteDevState): {
	label: string;
	tone: Tone;
} {
	return SESSION_STATE[state];
}

/** agent 状态的展示文案。 */
export function agentStateBadge(state: RemoteDevAgentState): {
	label: string;
	tone: Tone;
} {
	return AGENT_STATE[state];
}

/** 附着模式的展示文案。 */
export function attachModeLabel(mode: RemoteDevAttachmentMode): string {
	return ATTACH_MODE[mode];
}

/**
 * 会话是否已结束。
 *
 * `REMOTE_DEV_TERMINAL_STATES` 是窄元组，直接 `.includes(宽联合)` 会被类型系统拒绝；
 * 这里统一放宽成 `readonly RemoteDevState[]` 后再判定。
 */
export function isTerminalState(state: RemoteDevState): boolean {
	return (REMOTE_DEV_TERMINAL_STATES as readonly RemoteDevState[]).includes(state);
}

/** 清理状态的中文名；`complete` 之外都值得提示。 */
export function cleanupLabel(
	status: RemoteDevSessionInfo["cleanupStatus"],
): string | null {
	switch (status) {
		case "complete":
			return null;
		case "unknown":
			return "资源清理待确认";
		case "partial":
			return "资源仅部分清理";
		case "failed":
			return "资源清理失败";
	}
}

/**
 * RDS 错误码的中文化。
 *
 * 直接渲染 `RDS_RESUME_MISMATCH` 对使用者没有意义；这里是唯一映射点，
 * 未知错误码原样返回，避免把真实原因吞掉。
 */
const ERROR_TEXT: Record<string, string> = {
	RDS_OPERATOR_REQUIRED: "只有会话创建者可以操作这个会话",
	RDS_OPERATOR_CONFLICT: "已有其他操作者附着，稍后再试",
	RDS_SESSION_NOT_FOUND: "会话不存在或已过期",
	RDS_SESSION_CLOSED: "会话已结束",
	RDS_RESUME_NOT_ALLOWED: "该会话仍在运行，不能续接；请直接打开它",
	RDS_RESUME_UNAVAILABLE: "该会话没有可续接的 agent 上下文",
	RDS_RESUME_MISMATCH: "续接要求同一台机器、同一个 agent 与同一个 workspace",
	RDS_RESUME_FAILED: "agent 未能恢复原会话上下文",
	RDS_AGENT_UNAVAILABLE: "目标机器上的 agent 不在线",
	RDS_AGENT_START_FAILED: "agent 启动失败",
	RDS_PORT_LIMIT: "单会话端口数量已达上限",
	RDS_ATTACH_FAILED: "无法附着会话",
	RDS_FORBIDDEN: "没有权限",
};

/** 把错误码翻译成可读文案；未知码原样返回。 */
export function describeRemoteDevError(codeOrMessage: string): string {
	return ERROR_TEXT[codeOrMessage] ?? codeOrMessage;
}

/** 从异常里取错误码并翻译。 */
export function errorTextFrom(cause: unknown, fallback: string): string {
	const code = (cause as { code?: unknown }).code;
	return typeof code === "string" ? describeRemoteDevError(code) : fallback;
}

/** 绝对时间，`—` 表示缺失。 */
export function formatTime(value?: string): string {
	if (!value) return "—";
	const at = new Date(value);
	return Number.isNaN(at.getTime()) ? "—" : at.toLocaleString();
}

/** 相对时间（`刚刚` / `3 分钟前` / 具体时间），超过一天回落为绝对时间。 */
export function formatRelative(value?: string): string {
	if (!value) return "—";
	const at = new Date(value);
	if (Number.isNaN(at.getTime())) return "—";
	const diff = Date.now() - at.getTime();
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return at.toLocaleString();
}
