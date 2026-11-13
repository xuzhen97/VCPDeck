/**
 * 本机 launcher 控制通道客户端（客户端侧，与服务端 release/launcher-client.ts 同协议）。
 * Launcher 监听 127.0.0.1 + token，并写入 control.json。
 * 详见 docs/design/release-and-update.md。
 * - prepare：launcher 受理后台下载/校验/解压新版本（立即返回，不代表已完成）
 * - prepare/status：查询后台准备进度；apply 前必须等到 ready
 * - apply：launcher 停掉本进程并切换版本（响应无法送达属正常，视为成功）
 *
 * 不变式：launcher 会被冻结在安装时的构件版本，不随自更新替换，因此
 * 「等 prepare 完成」的责任在调用方（本客户端/服务端），不能指望 launcher 代劳。
 */
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type LauncherPrepareStatus,
	ReleaseArtifactErrorCode,
	type ReleaseDeltaCandidate,
} from "@vcpdeck/shared";

export interface LauncherControl {
	port: number;
	token: string;
}

export interface ClientLauncherOptions {
	/** control.json 路径（默认 ~/.vcpdeck/launcher/control.json） */
	controlFile?: string;
	/** fetch 实现（测试注入） */
	fetchImpl?: typeof fetch;
}

/** 轮询 /prepare/status 的默认间隔与总上限：组装数十秒，慢链路留足余量。 */
const DEFAULT_PREPARE_POLL_INTERVAL_MS = 1000;
const DEFAULT_PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_CONTROL_FILE = join(
	process.env.VCPDECK_APP_DIR ?? join(homedir(), ".vcpdeck", "launcher"),
	"control.json",
);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** /prepare/status 是跨进程输入，逐字段校验，未知 state 不宽松猜测。 */
function parsePrepareStatus(value: unknown): LauncherPrepareStatus {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("launcher /prepare/status 响应无效");
	}
	const status = value as Record<string, unknown>;
	const { state } = status;
	if (state !== "ready" && state !== "preparing" && state !== "failed") {
		throw new Error(`launcher /prepare/status 状态未知: ${String(state)}`);
	}
	const version = status.version;
	if (version !== null && typeof version !== "string") {
		throw new Error("launcher /prepare/status version 无效");
	}
	const errorCode = status.errorCode;
	if (errorCode !== undefined && typeof errorCode !== "string") {
		throw new Error("launcher /prepare/status errorCode 无效");
	}
	return {
		state,
		version: version ?? null,
		...(errorCode === undefined ? {} : { errorCode }),
	};
}

export class ClientLauncher {
	private readonly controlFile: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ClientLauncherOptions = {}) {
		this.controlFile = options.controlFile ?? DEFAULT_CONTROL_FILE;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	private async readControl(): Promise<LauncherControl> {
		const raw = await readFile(this.controlFile, "utf-8");
		let parsed: Partial<LauncherControl>;
		try {
			parsed = JSON.parse(raw) as Partial<LauncherControl>;
		} catch {
			throw new Error(`launcher control.json 无效: ${this.controlFile}`);
		}
		if (!parsed?.port || !parsed?.token) {
			throw new Error(`launcher control.json 无效: ${this.controlFile}`);
		}
		return { port: parsed.port, token: parsed.token };
	}

	private async send(
		ctl: LauncherControl,
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const res = await this.fetchImpl(`http://127.0.0.1:${ctl.port}${path}`, {
			method,
			headers: {
				"content-type": "application/json",
				"x-launcher-token": ctl.token,
			},
			...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`launcher ${path} 失败: HTTP ${res.status} ${text}`);
		}
		if (method === "GET") return (await res.json()) as unknown;
		return undefined;
	}

	/** 查询后台准备状态。 */
	async getPrepareStatus(): Promise<LauncherPrepareStatus> {
		const ctl = await this.readControl();
		return parsePrepareStatus(await this.send(ctl, "GET", "/prepare/status"));
	}

	/** 第一阶段：让 launcher 受理新版本准备（下载/校验/解压），返回不代表完成。 */
	async prepareUpdate(input: {
		version: string;
		url: string;
		sha256: string;
		/** 候选增量包；由 Launcher 按本地基线自选，缺省只用 full 包 */
		candidates?: ReleaseDeltaCandidate[];
	}): Promise<void> {
		const ctl = await this.readControl();
		await this.send(ctl, "POST", "/prepare", input);
	}

	/**
	 * 第二阶段的闸门：轮询 /prepare/status 直到 ready。
	 * prepared 失败立即抛错（带 launcher 的稳定错误码），超时抛错。
	 */
	async waitForPrepared(
		options: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<void> {
		const ctl = await this.readControl();
		const timeoutMs = options.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
		const intervalMs = options.intervalMs ?? DEFAULT_PREPARE_POLL_INTERVAL_MS;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const status = parsePrepareStatus(
				await this.send(ctl, "GET", "/prepare/status"),
			);
			if (status.state === "ready") return;
			if (status.state === "failed") {
				throw new Error(
					`launcher 准备失败: ${status.errorCode ?? ReleaseArtifactErrorCode.ASSEMBLE_FAILED}`,
				);
			}
			if (Date.now() >= deadline) {
				throw new Error(`launcher 准备超时（${timeoutMs}ms）`);
			}
			await sleep(intervalMs);
		}
	}

	/** 第三阶段：让 launcher 停掉本进程并切换版本（连接被掐断=成功） */
	async applyUpdate(): Promise<void> {
		const ctl = await this.readControl();
		try {
			await this.send(ctl, "POST", "/apply", {});
		} catch (e) {
			// launcher 停止本进程时 HTTP 连接会被直接切断；网络层异常的具体
			// 类型随 Node/undici 版本变化。只有明确的 HTTP 错误仍需失败。
			if (
				e instanceof Error &&
				e.message.startsWith("launcher /apply 失败: HTTP ")
			)
				throw e;
			return;
		}
	}
}