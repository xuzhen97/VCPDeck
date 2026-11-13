/**
 * 本机 Launcher 控制通道 HTTP 客户端。
 * 详见 docs/design/release-and-update.md。
 *
 * launcher 启动时监听 127.0.0.1 随机端口并写入 control.json：
 *   { port, token, pid }
 * 两阶段自更新协议：
 *   1) POST /prepare         —— launcher 受理后台下载/校验/解压（立即返回）
 *   2) GET  /prepare/status  —— 查询后台准备进度，apply 前必须等到 ready
 *   3) POST /apply           —— launcher 停掉本进程并切换版本（响应通常无法送达）
 *
 * 不变式：launcher 会被冻结在安装时的构件版本，不随自更新替换，因此
 * 「等 prepare 完成」的责任在调用方，不能指望 launcher 代劳。
 */
import { Injectable, Optional } from "@nestjs/common";
import {
	type LauncherPrepareStatus,
	ReleaseArtifactErrorCode,
	type ReleaseDeltaCandidate,
	describeTransportError,
} from "@vcpdeck/shared";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LauncherControl {
	port: number;
	token: string;
}

export interface LauncherHttpClientOptions {
	/** control.json 路径（默认 ~/.vcpdeck/launcher/control.json） */
	controlFile?: string;
	/** fetch 实现（测试注入） */
	fetchImpl?: typeof fetch;
}

/** 轮询 /prepare/status 的默认间隔与总上限：组装数十秒，慢链路留足余量。 */
const DEFAULT_PREPARE_POLL_INTERVAL_MS = 1000;
const DEFAULT_PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

/** 幂等 GET 的网络层重试次数与间隔：本机回环也可能因连接复用竞态失败一次。 */
const NETWORK_ATTEMPT_LIMIT = 3;
const NETWORK_RETRY_DELAY_MS = 200;

const DEFAULT_CONTROL_FILE = join(
	process.env.VCPDECK_APP_DIR ?? join(homedir(), ".vcpdeck", "launcher"),
	"control.json",
);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 控制通道连不上（网络层失败）：与 launcher 明确的 HTTP 拒绝区分，可重试。 */
class LauncherUnreachableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LauncherUnreachableError";
	}
}

/** /prepare/status 是跨进程输入，逐字段校验，未知 state 不宽松猜测。 */
function parsePrepareStatus(value: unknown): LauncherPrepareStatus {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("launcher /prepare/status 响应无效");
	}
	const status = value as Record<string, unknown>;
	const { state } = status;
	// idle = 尚未受理/尚未开始；preparing = 后台下载或组装中。两者都只代表
	// 「还没好」，由调用方继续轮询到 ready 或 failed。
	if (
		state !== "idle" &&
		state !== "preparing" &&
		state !== "ready" &&
		state !== "failed"
	) {
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

@Injectable()
export class LauncherHttpClient {
	private readonly controlFile: string;
	private readonly fetchImpl: typeof fetch;

	constructor(@Optional() options: LauncherHttpClientOptions = {}) {
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
		const url = `http://127.0.0.1:${ctl.port}${path}`;
		// GET 是幂等探测，网络层失败可以安全重发；POST 不重试：/prepare 与
		// /apply 的重发会重复执行（prepare 幂等性靠 launcher 自检，apply 没有）。
		const attempts = method === "GET" ? NETWORK_ATTEMPT_LIMIT : 1;
		for (let attempt = 1; ; attempt += 1) {
			let res: Response;
			try {
				res = await this.fetchImpl(url, {
					method,
					headers: {
						"content-type": "application/json",
						"x-launcher-token": ctl.token,
					},
					...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
				});
			} catch (e) {
				if (attempt < attempts) {
					await sleep(NETWORK_RETRY_DELAY_MS);
					continue;
				}
				throw new LauncherUnreachableError(
					`launcher ${path} 连不上: ${describeTransportError(e)}`,
				);
			}
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`launcher ${path} 失败: HTTP ${res.status} ${text}`);
			}
			if (method === "GET") return (await res.json()) as unknown;
			return undefined;
		}
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
		/** ADR-0062：登记的增量候选，launcher 自选基线组装；缺省时按全量下载 */
		candidates?: ReleaseDeltaCandidate[];
	}): Promise<void> {
		const ctl = await this.readControl();
		await this.send(ctl, "POST", "/prepare", input);
	}

	/**
	 * 第二阶段的闸门：轮询 /prepare/status 直到 ready。
	 * 准备失败立即抛错（带 launcher 的稳定错误码），超时抛错。
	 */
	async waitForPrepared(
		options: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<void> {
		const ctl = await this.readControl();
		const timeoutMs = options.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
		const intervalMs = options.intervalMs ?? DEFAULT_PREPARE_POLL_INTERVAL_MS;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			let status: LauncherPrepareStatus;
			try {
				status = parsePrepareStatus(
					await this.send(ctl, "GET", "/prepare/status"),
				);
			} catch (e) {
				// 控制通道瞬时连不上（launcher 刚切换端口/回环抖动）继续等；
				// 明确的 HTTP 拒绝或响应非法说明 launcher 真的答不了，立即失败。
				if (!(e instanceof LauncherUnreachableError) || Date.now() >= deadline) {
					throw e;
				}
				await sleep(intervalMs);
				continue;
			}
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

	/**
	 * 第三阶段：让 launcher 停掉本进程并切换版本。
	 * 2xx 或连接被 launcher 掐断（本进程被停）都视为成功。
	 */
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