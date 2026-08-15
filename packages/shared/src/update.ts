// ── 自更新协议（server ↔ client 经 WebSocket，launcher 经本地控制通道） ──
// 详见 docs/self-update-release-design.md

/** 更新包 manifest（打包时生成，随 zip 携带） */
export interface UpdateManifest {
	version: string;
	/** 所需 Node 版本约束（如 ">=24"），launcher ensure-node 使用 */
	nodeVersion: string;
	/** launcher 最低兼容版本（launcher 冻结，仅做校验） */
	launcherMinVersion: string;
	/** zip 整体 sha256（打包生成，上传时服务端复核，下载后再校验） */
	sha256: string;
	artifacts: {
		server?: {
			dir: string;
			entry: string;
			/** 启动前钩子，如 "prisma db push" */
			preStart?: string;
		};
		client?: {
			dir: string;
			entry: string;
		};
	};
}

/** 服务端 → 客户端：请求更新（含下载地址与校验值） */
export interface UpdateRequest {
	releaseVersion: string;
	/** 更新包下载 URL（客户端 launcher 使用） */
	url: string;
	sha256: string;
	/** 优雅停机等待上限（ms），缺省 10 分钟 */
	timeoutMs?: number;
}

/** 客户端 → 服务端：优雅停机完成，launcher 即将接管 */
export interface UpdateReady {
	clientId: string;
	releaseVersion: string;
}

/** 客户端 → 服务端：更新失败（原因仅安全摘要，不含文件内容） */
export interface UpdateFailed {
	clientId: string;
	releaseVersion: string;
	reason: string;
}

/** 服务端 → 广播：服务端即将重启（客户端保持运行，稍后自动重连） */
export interface ServerShutdownNotice {
	expectedVersion?: string;
	reconnectDelayMs?: number;
}

/** Release 状态机：uploaded → updating_server → updating_clients → done/failed */
export enum ReleaseStatus {
	UPLOADED = "uploaded",
	UPDATING_SERVER = "updating_server",
	UPDATING_CLIENTS = "updating_clients",
	DONE = "done",
	FAILED = "failed",
}

/** 单客户端在某个 release 中的更新状态 */
export enum ReleaseClientState {
	PENDING = "pending",
	UPDATING = "updating",
	DONE = "done",
	FAILED = "failed",
}

/** release 列表项（REST 返回） */
export interface ReleaseInfo {
	version: string;
	sha256: string;
	size: number;
	status: ReleaseStatus;
	errorMessage?: string | null;
	createdAt: string;
	updatedAt: string;
	/** clientId -> 更新状态（JSON 字符串在 DB，API 层解析为对象） */
	clientStates: Record<string, ReleaseClientState>;
}
