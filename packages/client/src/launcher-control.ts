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
	describeTransportError,
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

/**
 * 控制通道的传输层重试：launcher 在 prepare 期间用同步 I/O 组装/校验，
 * 事件循环被占满超过 HTTP keep-alive 窗口后，复用的连接会被作废，客户端
 * 只看到裸 `fetch failed`（ECONNRESET）。重试一次即可命中，因为 launcher
 * 已恢复响应；这里的重试只是不让一次瞬时失败打断整次更新。
 */
const CONTROL_ATTEMPT_LIMIT = 3;
const CONTROL_RETRY_DELAY_MS = 100;

const DEFAULT_CONTROL_FILE = join(
	process.env.VCPDECK_APP_DIR ?? join(homedir(), ".vcpdeck", "launcher"),
	"control.json",
);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 区分协议级失败与传输层失败：本模块与 parser 抛出的协议错误消息一律以
 * `launcher ` 开头；其余（undici 的 fetch failed、control.json 读取失败）
 * 都属于「控制通道暂时不可用」，可以重试。
 */
function isTransportFailure(error: unknown): boolean {
	return !(error instanceof Error && error.message.startsWith("launcher "));
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

	/**
	 * 控制通道调用：每次重读 control.json（launcher 重启会换端口），传输层
	 * 失败有限重试；协议级失败（HTTP 状态、响应无效）立即抛出。
	 */
	private async call(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<unknown> {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await this.send(await this.readControl(), method, path, body);
			} catch (e) {
				if (!isTransportFailure(e)) throw e;
				if (attempt >= CONTROL_ATTEMPT_LIMIT) {
					throw new Error(
						`launcher ${path} 连不上: ${describeTransportError(e)}`,
					);
				}
				await sleep(CONTROL_RETRY_DELAY_MS * attempt);
			}
		}
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
		return parsePrepareStatus(await this.call("GET", "/prepare/status"));
	}

	/** 第一阶段：让 launcher 受理新版本准备（下载/校验/解压），返回不代表完成。 */
	async prepareUpdate(input: {
		version: string;
		url: string;
		sha256: string;
		/** 候选增量包；由 Launcher 按本地基线自选，缺省只用 full 包 */
		candidates?: ReleaseDeltaCandidate[];
	}): Promise<void> {
		// 重复受理是安全的：launcher 的 prepare 对已准备好的版本直接短路。
		await this.call("POST", "/prepare", input);
	}

	/**
	 * 第二阶段的闸门：轮询 /prepare/status 直到 ready。
	 * prepared 失败立即抛错（带 launcher 的稳定错误码），超时抛错。
	 *
	 * 传输层失败不算失败：launcher 在 prepare 期间用同步 I/O 组装，事件循环
	 * 被占满时复用的连接会被作废（裸 `fetch failed`），此时它只是暂时答不上
	 * 话，继续轮询即可；只有拖到总超时才算失败。
	 */
	async waitForPrepared(
		options: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<void> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
		const intervalMs = options.intervalMs ?? DEFAULT_PREPARE_POLL_INTERVAL_MS;
		const deadline = Date.now() + timeoutMs;
		let lastTransport: string | null = null;
		for (;;) {
			let status: LauncherPrepareStatus | null = null;
			try {
				status = parsePrepareStatus(
					await this.send(
						await this.readControl(),
						"GET",
						"/prepare/status",
					),
				);
				lastTransport = null;
			} catch (e) {
				if (!isTransportFailure(e)) throw e;
				lastTransport = describeTransportError(e);
			}
			if (status !== null) {
				if (status.state === "ready") return;
				if (status.state === "failed") {
					throw new Error(
						`launcher 准备失败: ${status.errorCode ?? ReleaseArtifactErrorCode.ASSEMBLE_FAILED}`,
					);
				}
			}
			if (Date.now() >= deadline) {
				throw new Error(
					lastTransport === null
						? `launcher 准备超时（${timeoutMs}ms）`
						: `launcher 准备超时（${timeoutMs}ms）: ${lastTransport}`,
				);
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